from __future__ import annotations
import io
import logging
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt
from agent.agents.bidding_agent.schemas import DeckSpec, Slide

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


def _bullets_box(slide, bullets: list[str], tokens: dict) -> None:
    """要点文本框：每条要点独立段落，手动 “• ” 前缀，16pt，段后距 10pt，自动换行。"""
    tf = slide.shapes.add_textbox(_MARGIN, Inches(1.4), _CONTENT_W, Inches(4.7)).text_frame
    tf.word_wrap = True
    for i, bullet in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = f"• {bullet}"
        p.space_after = Pt(10)
        run = p.runs[0]
        run.font.size = Pt(16)
        run.font.color.rgb = tokens["text"]


def _chip_width(text: str) -> int:
    """评分点角标自适应宽度：按字符数 * 0.11in 估算，夹在 [2.5in, 9in] 之间。"""
    return int(Inches(max(2.5, min(9.0, 0.11 * len(text)))))


def _scoring_chip(slide, scoring: str, tokens: dict) -> None:
    """底部左侧圆角矩形评分点角标：浅底色 + 细强调边框 + 强调色文字。"""
    text = f"评分点｜{scoring}"
    width = _chip_width(text)
    shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, _MARGIN, Inches(6.55), width, Inches(0.5))
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
    run = p.runs[0]
    run.font.size = Pt(12)
    run.font.color.rgb = tokens["accent"]


def _page_number(slide, n: int, total: int, tokens: dict) -> None:
    """底部右侧页码 “n / total”，10pt 弱化灰。"""
    _textbox(slide, _SLIDE_W - Inches(1.6), Inches(6.65), Inches(1.2), Inches(0.4),
              [f"{n} / {total}"], size=10, color=tokens["muted"], align=PP_ALIGN.RIGHT)


def _render_content(slide, s: Slide, tokens: dict, n: int, total: int) -> None:
    """正文页：标题行 + 要点 + 评分点角标（可空）+ 页码。"""
    _title_row(slide, s.title, tokens)
    if s.bullets:
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
    n = 0
    for s in deck.slides:
        slide = prs.slides.add_slide(blank)
        if s.kind == "cover":
            _render_cover(slide, s, tokens)
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
    """正文页（母版路径）：标题/正文优先落母版占位符，缺失则退回空白设计同款绘制；
    评分点角标和页码母版版式不会自带，恒定自绘（配色取模板 token 的强调色，和母版视觉融合）。"""
    title_ph = _title_placeholder(slide)
    if title_ph is not None:
        title_ph.text_frame.text = s.title
    else:
        _title_row(slide, s.title, tokens)
    if s.bullets:
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
    n = 0
    for s in deck.slides:
        if s.kind == "cover":
            slide = prs.slides.add_slide(title_layout)
            _render_cover_on_master(slide, s, tokens)
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
