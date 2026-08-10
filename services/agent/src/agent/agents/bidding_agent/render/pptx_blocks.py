"""述标 PPT 的绘制积木：几何/图形原语 + 封面、标题行、要点卡三族版式画法。

模板之间的差异全部落在这三族上（配色与结构开关见 render/styles.py）。每族一个派发表，
渲染层只按 token 里的枚举取画法，**未知取值回退各自默认值**——加新模板只需在 styles.py
登记 token 并在这里补一个画法函数，deck 组装逻辑（render/pptx.py）一行都不用改。
"""
from __future__ import annotations

import logging

from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

from agent.agents.bidding_agent.render.styles import is_dark, on_primary
from agent.agents.bidding_agent.schemas import Slide

logger = logging.getLogger(__name__)

SLIDE_W, SLIDE_H = Inches(13 + 1 / 3), Inches(7.5)  # 12192000 / 6858000 EMU：标准 16:9
MARGIN = Inches(0.7)


# ---- 几何：一律按幻灯片真实尺寸算，别取全局常量 ----

def slide_size(slide) -> tuple[int, int]:
    """该幻灯片所属演示文稿的真实页面尺寸（EMU）。
    企业母版路径**沿用客户自己的页面尺寸**（_render_on_master 不改 slide_width/height），
    死写 16:9 常量在 4:3 母版（10in 宽）上会把图表推出页面 2.63in——约四分之一被裁掉
    （评审实测复现）。取不到就退回 16:9 常量，与空白设计路径一致。"""
    try:
        pres = slide.part.package.presentation_part.presentation
        return pres.slide_width, pres.slide_height
    except Exception:      # noqa: BLE001 拿不到尺寸绝不能让整份述标渲染失败
        logger.warning("读取母版页面尺寸失败，按 16:9 常量绘制", exc_info=True)
        return SLIDE_W, SLIDE_H


def content_box(slide) -> tuple[int, int, int]:
    """(左边距, 正文可用宽, 页高)：所有版式统一用它算几何。"""
    w, h = slide_size(slide)
    return MARGIN, w - 2 * MARGIN, h


def body_band(slide) -> tuple[int, int]:
    """正文区上下沿：下沿按页高算，给底部的评分点角标/页码留出 1.2in（母版页高不同也不会压住）。"""
    _, _, sh = content_box(slide)
    return Inches(1.5), sh - Inches(1.2)


# ---- 图形/文字原语 ----

def blend_toward(base: RGBColor, target: RGBColor, ratio: float) -> RGBColor:
    """按比例把 base 色向 target 混合（无法用 pptx 做透明度，用混色近似"80% 透明白"视觉效果）。"""
    return RGBColor(*(round(b * (1 - ratio) + t * ratio) for b, t in zip(base, target)))


def rect(slide, left, top, width, height, fill_rgb, *, line_rgb=None, line_pt=None):
    """无框（或指定描边）的纯色矩形，封面色带/分隔线/强调条/标题小方块共用。"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, int(left), int(top), int(width), int(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_rgb
    if line_rgb is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_rgb
        shape.line.width = line_pt or Pt(0.75)
    return shape


def rounded_rect(slide, left, top, width, height, fill_rgb, *, line_rgb=None, line_pt=None):
    """圆角矩形（要点卡片/数字卡片/角标共用），描边规则同 rect。"""
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                   int(left), int(top), int(width), int(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill_rgb
    if line_rgb is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_rgb
        shape.line.width = line_pt or Pt(0.75)
    return shape


def gradient_rect(slide, left, top, width, height, c1: RGBColor, c2: RGBColor, angle: float = 45.0):
    """渐变矩形。纯色大色块是"代码画的"最明显的特征——同一块面积换成渐变，观感立刻接近
    设计稿。python-pptx 原生支持渐变填充，产物仍是可编辑形状，不是图片。"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                   int(left), int(top), int(width), int(height))
    shape.fill.gradient()
    stops = shape.fill.gradient_stops
    stops[0].color.rgb = c1
    stops[0].position = 0.0
    stops[1].color.rgb = c2
    stops[1].position = 1.0
    # 多于两个停靠点时把其余的并到末端，避免默认主题色混进来
    for extra in list(stops)[2:]:
        extra.color.rgb = c2
        extra.position = 1.0
    shape.fill.gradient_angle = angle
    shape.line.fill.background()
    return shape


def textbox(slide, left, top, width, height, lines, *, size, color, bold=False, align=None):
    """单个文本框，lines 逐行成段；每段单 run（够用且最稳），字号/颜色/加粗/对齐统一设置。"""
    tf = slide.shapes.add_textbox(int(left), int(top), int(width), int(height)).text_frame
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


def paint_surface(slide, tokens: dict) -> None:
    """深色模板铺满页底色（浅色模板不铺：空白版式本来就是白底，多画一层只会盖住母版元素）。
    必须最先画——后画的形状才会叠在它上面。"""
    if not is_dark(tokens):
        return
    sw, sh = slide_size(slide)
    rect(slide, 0, 0, sw, sh, tokens["bg"])


def accent_bar(slide, accent_rgb) -> None:
    """封面/结束页底部的通栏细强调条（0.06in），按真实页宽画——死写 16:9 常量会伸出窄母版之外。"""
    sw, sh = slide_size(slide)
    rect(slide, 0, sh - Inches(0.06), sw, Inches(0.06), accent_rgb)


# ---- 封面族：cover 开关 ----

def _cover_fullbleed(slide, s: Slide, tokens: dict) -> None:
    """满幅封面（商务提案）：整页主色（走渐变，纯色大块最像"代码画的"）+ 顶部细线小标签，
    标题压在下半页、上方一道贯通细线分栏，投标人信息贴在标题下方——像企业实力手册的封面。"""
    sw, sh = slide_size(slide)
    fg = on_primary(tokens)
    deep = blend_toward(tokens["primary"], RGBColor(0, 0, 0), 0.42)
    gradient_rect(slide, 0, 0, sw, sh, deep, tokens["primary"], angle=90.0)
    left = sw * 0.07
    rect(slide, left, sh * 0.15, sw * 0.05, Pt(2.5), tokens["accent"])
    textbox(slide, left, sh * 0.185, sw * 0.6, Inches(0.4), ["述标演示"],
            size=13, color=blend_toward(fg, tokens["primary"], 0.28))
    rect(slide, left, sh * 0.50, sw * 0.86, Pt(1), blend_toward(fg, tokens["primary"], 0.55))
    textbox(slide, left, sh * 0.545, sw * 0.80, Inches(1.9), [s.title], size=40, color=fg, bold=True)
    if s.bullets:
        textbox(slide, left, sh * 0.795, sw * 0.80, Inches(1.0), s.bullets,
                size=13, color=blend_toward(fg, tokens["primary"], 0.32))
    accent_bar(slide, tokens["accent"])


def _cover_split(slide, s: Slide, tokens: dict) -> None:
    """分栏封面（技术方案）：左栏主色实底压标题，右栏整片留白放副标题与投标人信息，
    中缝一道强调色细线——留白本身就是这套模板的性格，不再铺满色块。"""
    sw, sh = slide_size(slide)
    col = int(sw * 0.46)
    pad = int(sw * 0.055)
    fg = on_primary(tokens)
    rect(slide, 0, 0, col, sh, tokens["primary"])
    rect(slide, col, 0, Pt(3), sh, tokens["accent"])
    rect(slide, pad, sh * 0.30, Inches(0.7), Pt(3), fg)
    textbox(slide, pad, sh * 0.35, col - 2 * pad, Inches(2.4), [s.title], size=32, color=fg, bold=True)
    textbox(slide, col + pad, sh * 0.35, sw - col - 2 * pad, Inches(0.5), ["述标演示"],
            size=15, color=tokens["accent"])
    if s.bullets:
        textbox(slide, col + pad, sh * 0.46, sw - col - 2 * pad, Inches(1.4), s.bullets,
                size=13, color=tokens["text"])


def _cover_banner(slide, s: Slide, tokens: dict) -> None:
    """通栏横幅封面（党政庄重）：一条横贯页面的主色带压住标题，上沿一道烫金细线，
    投标人信息紧跟横幅下方——正式采购场合最常见的封面处理，庄重且不喧宾夺主。"""
    sw, sh = slide_size(slide)
    top, band_h = int(sh * 0.30), int(sh * 0.30)
    left = int(sw * 0.09)
    rect(slide, 0, top - Pt(5), sw, Pt(5), tokens["accent"])
    rect(slide, 0, top, sw, band_h, tokens["primary"])
    textbox(slide, left, top - Inches(0.66), sw - 2 * left, Inches(0.4), ["述标演示"],
            size=15, color=tokens["muted"])
    textbox(slide, left, top + band_h * 0.24, sw - 2 * left, band_h * 0.6, [s.title],
            size=34, color=on_primary(tokens), bold=True)
    if s.bullets:
        textbox(slide, left, top + band_h + Inches(0.4), sw - 2 * left, Inches(1.0),
                s.bullets, size=13, color=tokens["text"])
    accent_bar(slide, tokens["accent"])


_COVERS = {"fullbleed": _cover_fullbleed, "split": _cover_split, "banner": _cover_banner}


def render_cover(slide, s: Slide, tokens: dict) -> None:
    """封面页：按 cover 开关取画法，未知取值回退满幅封面（最通用的一款）。"""
    _COVERS.get(tokens.get("cover"), _cover_fullbleed)(slide, s, tokens)


# ---- 标题行族：header 开关 ----

def _title_overline(slide, title: str, tokens: dict, index: int | None, kicker: str) -> None:
    """标题行（商务提案）：细线 + 小标签（overline）压在标题上方，标题下不再画通栏线——
    小标签走项目名（running head），评委翻到任意一页都知道这是哪个项目的述标。"""
    left, content_w, _ = content_box(slide)
    rect(slide, left, Inches(0.46), Inches(0.5), Pt(2.5), tokens["accent"])
    textbox(slide, left + Inches(0.64), Inches(0.38), content_w - Inches(0.64), Inches(0.32),
            [kicker or "述标演示"], size=11, color=tokens["accent"])
    textbox(slide, left, Inches(0.72), content_w, Inches(0.62), [title], size=26,
            color=tokens["text"], bold=True)


def _title_numeral(slide, title: str, tokens: dict, index: int | None, kicker: str) -> None:
    """标题行（技术方案）：大号章节数字起标题，除此之外什么都不画——正文首行的发丝线本身
    就是分隔（再画一道标题线会和它挨成两条平行线，实测像画歪了而不像设计）。"""
    left, content_w, _ = content_box(slide)
    num_w = Inches(1.05)
    textbox(slide, left, Inches(0.42), num_w, Inches(0.8),
            [f"{index:02d}" if index else "—"], size=34, color=tokens["accent"], bold=True)
    textbox(slide, left + num_w, Inches(0.56), content_w - num_w, Inches(0.6), [title],
            size=25, color=tokens["text"], bold=True)


def _title_corner(slide, title: str, tokens: dict, index: int | None, kicker: str) -> None:
    """标题行（党政庄重）：贴左边缘的主色角标（内嵌页序）+ 标题 + 标题下半幅烫金短线。"""
    left, content_w, _ = content_box(slide)
    tab_w = left + Inches(0.34)
    rect(slide, 0, Inches(0.44), tab_w, Inches(0.68), tokens["primary"])
    textbox(slide, 0, Inches(0.56), tab_w, Inches(0.4), [f"{index:02d}" if index else "标"],
            size=15, color=on_primary(tokens), bold=True, align=PP_ALIGN.CENTER)
    textbox(slide, tab_w + Inches(0.24), Inches(0.5), content_w - Inches(0.24), Inches(0.58),
            [title], size=25, color=tokens["text"], bold=True)
    rect(slide, tab_w + Inches(0.24), Inches(1.18), content_w * 0.42, Pt(2.5), tokens["accent"])


_TITLE_ROWS = {"overline": _title_overline, "numeral": _title_numeral, "corner": _title_corner}


def title_row(slide, title: str, tokens: dict, *, index: int | None = None, kicker: str = "") -> None:
    """正文页标题行：按 header 开关取画法，未知取值回退 overline。
    模板之间的区分主要就体现在这里，别在调用方按模板名分支。"""
    _TITLE_ROWS.get(tokens.get("header"), _title_overline)(slide, title, tokens, index, kicker)


# ---- 要点卡族：card 开关 ----

_CARD_GAP = Inches(0.16)
_CARD_MAX_H = Inches(1.3)
_BADGE = Inches(0.34)


def _card_text(shape, text: str, tokens: dict, *, left_margin: int) -> None:
    """卡片内的要点文字：垂直居中、按 left_margin 给序号让位、14pt 正文色。"""
    tf = shape.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf.margin_left, tf.margin_right = left_margin, Inches(0.2)
    p = tf.paragraphs[0]
    p.text = text
    p.alignment = PP_ALIGN.LEFT
    run = p.runs[0] if p.runs else p.add_run()
    run.font.size = Pt(14)
    run.font.color.rgb = tokens["text"]


def _badge(slide, left, top, idx: int, tokens: dict) -> None:
    """强调色圆角序号徽章（白字 13pt 加粗）。"""
    badge = rounded_rect(slide, left, top, _BADGE, _BADGE, tokens["accent"])
    tf = badge.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.text = str(idx)
    p.alignment = PP_ALIGN.CENTER
    run = p.runs[0] if p.runs else p.add_run()
    run.font.size = Pt(13)
    run.font.bold = True
    run.font.color.rgb = tokens["white"]


def _card_numbered(slide, left, top, width, height, idx: int, text: str, tokens: dict) -> None:
    """要点卡（商务提案）：浅底圆角卡 + 左侧大号序号（30pt）。序号比正文大一倍，
    评委扫一眼就知道这页有几条、看到第几条。"""
    card = rounded_rect(slide, left, top, width, height, tokens["tint"])
    textbox(slide, left + Inches(0.14), top + (height - Inches(0.66)) / 2, Inches(0.78), Inches(0.66),
            [str(idx)], size=30, color=tokens["accent"], bold=True, align=PP_ALIGN.CENTER)
    _card_text(card, text, tokens, left_margin=Inches(1.0))


def _card_hairline(slide, left, top, width, height, idx: int, text: str, tokens: dict) -> None:
    """要点行（技术方案）：不填底色，只在行首压一道发丝线 + 小号序号——留白即版式，
    深底上大面积浅色块会盖过图表，这套模板宁可什么都不填。"""
    rect(slide, left, top, width, Pt(0.75), tokens["muted"])
    # 序号与正文都按整行垂直居中：序号盒子若只给一行高，会浮在正文上方半行，看着像没对齐
    num = textbox(slide, left, top + Inches(0.12), Inches(0.6), height - Inches(0.24),
                  [f"{idx:02d}"], size=12, color=tokens["accent"], bold=True)
    num.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf = textbox(slide, left + Inches(0.66), top + Inches(0.12), width - Inches(0.76),
                 height - Inches(0.24), [text], size=14, color=tokens["text"])
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE


def _card_elevated(slide, left, top, width, height, idx: int, text: str, tokens: dict) -> None:
    """要点卡（党政庄重）：卡片下压一层偏移色块当轻阴影 + 烫金描边 + 序号徽章。
    python-pptx 没有阴影 API，用一层偏移块近似——产物仍是可编辑的原生形状，不是图片。"""
    off = Inches(0.05)
    rounded_rect(slide, left + off, top + off, width, height,
                 blend_toward(tokens["tint"], tokens["text"], 0.18))
    card = rounded_rect(slide, left, top, width, height, tokens["tint"],
                        line_rgb=tokens["accent"], line_pt=Pt(0.75))
    _badge(slide, left + Inches(0.18), top + (height - _BADGE) / 2, idx, tokens)
    _card_text(card, text, tokens, left_margin=Inches(0.72))


_CARDS = {"numbered": _card_numbered, "hairline": _card_hairline, "elevated": _card_elevated}


def _card_geometry(n: int, top: int, bottom: int) -> tuple[int, int]:
    """n 张卡片在 [top, bottom] 内的 (高度, 起始 y)：等分但封顶，整体垂直居中。
    封顶是为了 2 条要点时不出现两张 2.4in 的巨块；居中是为了消灭「内容挤在顶部、下面 60%
    全白」——用户原话「太素」，一半原因就是这片空白（4 条要点只占顶部约 25%）。"""
    area = bottom - top
    h = min(_CARD_MAX_H, int((area - (n - 1) * _CARD_GAP) / n))
    stack = n * h + (n - 1) * _CARD_GAP
    return h, top + int((area - stack) / 2)


def bullets_box(slide, bullets: list[str], tokens: dict, *, left=None, width=None) -> None:
    """要点区：按 card 开关逐条渲卡片（未知取值回退 numbered），等距铺开并整体垂直居中
    （对比页左栏传 left/width 复用同款卡片）。"""
    items = [b for b in bullets if b.strip()]
    if not items:
        return
    box_left, box_w, _ = content_box(slide)
    left = box_left if left is None else left
    width = box_w if width is None else width
    top, bottom = body_band(slide)
    h, y0 = _card_geometry(len(items), top, bottom)
    painter = _CARDS.get(tokens.get("card"), _card_numbered)
    for i, text in enumerate(items):
        painter(slide, left, y0 + i * (h + _CARD_GAP), width, h, i + 1, text, tokens)
