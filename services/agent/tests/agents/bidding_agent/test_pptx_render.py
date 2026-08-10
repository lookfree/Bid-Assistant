import io
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.util import Emu, Inches
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.render.pptx import render_pptx
from agent.agents.bidding_agent.render.styles import TEMPLATE_TOKENS as _TEMPLATE_TOKENS


def _deck():
    return DeckSpec(title="述标", slides=[
        {"id": "s0", "title": "封面", "bullets": ["客户：某局", "时长 15 分钟"], "kind": "cover"},
        {"id": "s1", "title": "运维体系", "bullets": ["7×24 值守", "分级 SLA", "故障 30 分钟响应"],
         "scoring": "技术方案 50 分", "notes": "讲稿…", "kind": "content"},
        {"id": "s2", "title": "感谢聆听", "kind": "end"},
    ])


def test_render_pptx_produces_valid_deck():
    data = render_pptx(_deck())
    assert data[:2] == b"PK"                       # .pptx 是 zip
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 3
    assert prs.slides[1].notes_slide.notes_text_frame.text == "讲稿…"


def test_slide_is_16_by_9():
    data = render_pptx(_deck())
    prs = Presentation(io.BytesIO(data))
    assert prs.slide_width == Emu(12192000)   # Inches(13.333)
    assert prs.slide_height == Emu(6858000)   # Inches(7.5)


def _solid_rgb(shape):
    """形状的纯色填充色；渐变/无填充/非图形一律给 None（直接取 fore_color 会抛错）。"""
    try:
        return shape.fill.fore_color.rgb
    except (AttributeError, TypeError, ValueError):
        return None


def test_blue_cover_is_a_full_bleed_gradient_with_the_title_in_the_lower_half():
    """商务提案的封面是满幅色块（走渐变——纯色大块最像"代码画的"），标题压在下半页，
    投标人信息跟在标题下方：整页没有一块无意义的白。"""
    from pptx.enum.dml import MSO_FILL
    prs = Presentation(io.BytesIO(render_pptx(_deck(), template="blue")))
    cover = prs.slides[0]
    grads = [sh for sh in cover.shapes
             if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and sh.fill.type == MSO_FILL.GRADIENT]
    assert grads, "封面色块没有用渐变"
    full = grads[0]
    assert full.width == prs.slide_width and full.height == prs.slide_height, "封面色块没有铺满整页"
    assert full.fill.gradient_stops[1].color.rgb == _TEMPLATE_TOKENS["blue"]["primary"]

    title_box = next(sh for sh in cover.shapes if sh.has_text_frame and sh.text_frame.text == "封面")
    run = title_box.text_frame.paragraphs[0].runs[0]
    assert run.font.size.pt == 40
    assert run.font.bold is True
    assert run.font.color.rgb == RGBColor(0xFF, 0xFF, 0xFF)
    assert title_box.top > prs.slide_height * 0.5, "满幅封面的标题要压在下半页"
    meta = next(sh for sh in cover.shapes if sh.has_text_frame and "客户：某局" in sh.text_frame.text)
    assert meta.top > title_box.top


def test_tech_cover_is_split_into_two_columns():
    """技术方案的封面是左右分栏：左栏一块主色实底压标题，右栏整片留白放投标人信息。"""
    prs = Presentation(io.BytesIO(render_pptx(_deck(), template="tech")))
    cover = prs.slides[0]
    col = next(sh for sh in cover.shapes
               if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and sh.height == prs.slide_height
               and _solid_rgb(sh) == _TEMPLATE_TOKENS["tech"]["primary"])
    assert prs.slide_width * 0.3 < col.width < prs.slide_width * 0.6, "左栏不是分栏宽度"
    title_box = next(sh for sh in cover.shapes if sh.has_text_frame and sh.text_frame.text == "封面")
    assert title_box.left + title_box.width <= col.width, "标题要落在左栏里"
    meta = next(sh for sh in cover.shapes if sh.has_text_frame and "客户：某局" in sh.text_frame.text)
    assert meta.left >= col.width, "投标人信息要落在右栏留白里"


def test_gov_cover_is_a_full_width_banner():
    """党政庄重的封面是通栏横幅：一条横贯页面的主色带压住标题，上下留白。"""
    prs = Presentation(io.BytesIO(render_pptx(_deck(), template="gov")))
    cover = prs.slides[0]
    banner = next(sh for sh in cover.shapes
                  if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and sh.width == prs.slide_width
                  and _solid_rgb(sh) == _TEMPLATE_TOKENS["gov"]["primary"])
    assert banner.top > 0, "横幅不该贴着页顶——上方要留白"
    assert banner.height < prs.slide_height * 0.5, "横幅是一条带子，不是满幅色块"
    title_box = next(sh for sh in cover.shapes if sh.has_text_frame and sh.text_frame.text == "封面")
    assert banner.top <= title_box.top <= banner.top + banner.height, "标题要压在横幅里"


def test_content_slide_bullets_and_scoring_chip():
    """要点从「单文本框 + • 前缀」改成逐条编号卡片（用户反馈整页太素、下半页全白）：
    一条要点一张卡，卡上有序号徽章，文字 14pt。全部是原生形状，仍可在 PowerPoint 里逐个改。"""
    data = render_pptx(_deck())
    prs = Presentation(io.BytesIO(data))
    content = prs.slides[1]
    cards = [sh for sh in content.shapes
             if sh.has_text_frame and sh.text_frame.text in
             ("7×24 值守", "分级 SLA", "故障 30 分钟响应")]
    assert len(cards) == 3
    for card in cards:
        assert card.text_frame.paragraphs[0].runs[0].font.size.pt == 14
    badges = [sh for sh in content.shapes
              if sh.has_text_frame and sh.text_frame.text in ("1", "2", "3")]
    assert len(badges) == 3, "每张卡片要有序号徽章"
    chip = next(sh for sh in content.shapes
                if sh.has_text_frame and "评分点｜" in sh.text_frame.text)
    assert chip.text_frame.text == "评分点｜技术方案 50 分"
    page_no = next(sh for sh in content.shapes
                   if sh.has_text_frame and "/" in sh.text_frame.text and sh is not chip)
    assert page_no.text_frame.text == "1 / 2"


def test_end_slide_has_thank_you_and_page_number():
    data = render_pptx(_deck())
    prs = Presentation(io.BytesIO(data))
    end = prs.slides[2]
    texts = [sh.text_frame.text for sh in end.shapes if sh.has_text_frame]
    assert "感谢聆听" in texts
    assert "2 / 2" in texts


def _tiny_master(width_in: float = 10.0, height_in: float = 7.5) -> bytes:
    """构造一个自带 1 张示例页的迷你母版（复用 python-pptx 内置模板的 layouts/theme）。"""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(width_in), Inches(height_in)
    prs.slides.add_slide(prs.slide_layouts[0])   # 母版自带的示例页，渲染时应被清空
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def test_render_on_master_removes_example_slide_and_keeps_master_size():
    data = render_pptx(_deck(), master_bytes=_tiny_master())
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 3                 # 示例页被删，只剩我们的 3 页
    assert prs.slide_width == Inches(10.0)       # 母版自身尺寸保留，不强制 16:9
    assert prs.slide_height == Inches(7.5)


def test_render_on_master_populates_titles_notes_and_chip():
    data = render_pptx(_deck(), master_bytes=_tiny_master())
    prs = Presentation(io.BytesIO(data))
    all_texts = [sh.text_frame.text for sl in prs.slides for sh in sl.shapes if sh.has_text_frame]
    assert {"封面", "运维体系", "感谢聆听"} <= set(all_texts)
    assert prs.slides[1].notes_slide.notes_text_frame.text == "讲稿…"
    chip = next(sh for sl in prs.slides for sh in sl.shapes
                if sh.has_text_frame and "评分点｜" in sh.text_frame.text)
    assert chip.text_frame.text == "评分点｜技术方案 50 分"


def _all_texts(prs: Presentation) -> list[str]:
    return [sh.text_frame.text for sl in prs.slides for sh in sl.shapes if sh.has_text_frame]


def test_end_slide_has_ai_notice_blank_path():
    """spec326 算法备案：结束页（空白设计路径）底部含 AI 生成提示短版文案（逐字不可改）。"""
    data = render_pptx(_deck())
    prs = Presentation(io.BytesIO(data))
    assert "本内容由 AI 辅助生成，仅供参考，请人工复核后使用" in _all_texts(prs)


def test_end_slide_has_ai_notice_master_path():
    """spec326：结束页（企业母版路径）同样含 AI 生成提示短版文案，两路径视觉一致。"""
    data = render_pptx(_deck(), master_bytes=_tiny_master())
    prs = Presentation(io.BytesIO(data))
    assert "本内容由 AI 辅助生成，仅供参考，请人工复核后使用" in _all_texts(prs)


def test_render_on_master_malformed_bytes_falls_back_to_blank():
    data = render_pptx(_deck(), master_bytes=b"not a pptx")
    assert data[:2] == b"PK"
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 3
    assert prs.slide_width == Emu(12192000)      # 回退空白设计：强制 16:9


# ---- 述标结构性升级：章节分隔页 / 图表页 / 对比页（三种新版式） ----

def _rich_deck():
    return DeckSpec(title="述标", slides=[
        {"id": "s0", "title": "封面", "bullets": ["客户：某局"], "kind": "cover"},
        {"id": "sec", "title": "技术方案", "bullets": ["核心能力与差异化优势"], "kind": "section"},
        {"id": "s1", "title": "团队构成", "kind": "content", "layout": "chart", "scoring": "团队 20 分",
         "bullets": ["60% 为中级及以上职称"],
         "chart": {"type": "pie", "categories": ["高级", "中级", "初级"],
                   "series": [{"name": "人数", "values": [3, 6, 4]}]}},
        {"id": "s2", "title": "业绩对比", "kind": "content", "layout": "comparison", "scoring": "业绩 15 分",
         "bullets": ["近三年同类项目 5 个", "合同额年增长 30%"],
         "stats": [{"value": "72 小时", "label": "较招标要求提前完成"},
                   {"value": "0 起", "label": "质量投诉记录"}]},
        {"id": "s3", "title": "结语", "kind": "end"},
    ])


def test_section_slide_is_full_color_with_centered_title():
    """章节分隔页：满屏主色块 + 居中大标题，不挂评分点角标（它是过渡页，不对应具体得分点）。"""
    data = render_pptx(_rich_deck())
    prs = Presentation(io.BytesIO(data))
    section = prs.slides[1]
    rects = [sh for sh in section.shapes if sh.shape_type == MSO_SHAPE.RECTANGLE]
    assert any(r.width == prs.slide_width and r.height == prs.slide_height for r in rects)
    texts = [sh.text_frame.text for sh in section.shapes if sh.has_text_frame]
    assert "技术方案" in texts
    assert not any("评分点｜" in t for t in texts)


def test_chart_slide_renders_a_real_editable_chart_not_an_image():
    """图表页：真实 PowerPoint 图表对象（python-pptx add_chart），评委能在 PPT 里直接编辑数值——
    这正是相对"糊一张图片上去"的核心差异，也是本次结构升级要验证的主张。"""
    data = render_pptx(_rich_deck())
    prs = Presentation(io.BytesIO(data))
    chart_slide = prs.slides[2]
    chart_shapes = [sh for sh in chart_slide.shapes if sh.has_chart]
    assert len(chart_shapes) == 1
    chart = chart_shapes[0].chart
    assert list(chart.plots[0].categories) == ["高级", "中级", "初级"]
    assert [s.name for s in chart.series] == ["人数"]
    assert list(chart.series[0].values) == [3, 6, 4]
    # 评分点角标仍在——图表版式不能因为换了主体就丢了述标的核心标注
    texts = [sh.text_frame.text for sh in chart_slide.shapes if sh.has_text_frame]
    assert any("评分点｜团队 20 分" in t for t in texts)


def test_comparison_slide_has_left_bullets_and_right_stat_cards():
    """对比页：左栏要点 + 右栏 1-2 张数字大卡片，两栏都要有——这是招标要求 vs 我方承诺、
    传统方案 vs 本方案这类内容该用的版式，比堆一排项目符号更有说服力。"""
    data = render_pptx(_rich_deck())
    prs = Presentation(io.BytesIO(data))
    cmp_slide = prs.slides[3]
    texts = [sh.text_frame.text for sh in cmp_slide.shapes if sh.has_text_frame]
    assert any("近三年同类项目 5 个" in t for t in texts)
    # shape_type 对所有自选图形都返回 AUTO_SHAPE，具体形状要看 auto_shape_type
    # （auto_shape_type 对非自选图形直接抛 ValueError，不是返回 None，得先判 shape_type）
    cards = [sh for sh in cmp_slide.shapes
             if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and sh.auto_shape_type == MSO_SHAPE.ROUNDED_RECTANGLE]
    card_texts = {c.text_frame.text for c in cards}
    assert any("72 小时" in t and "较招标要求提前完成" in t for t in card_texts)
    assert any("0 起" in t and "质量投诉记录" in t for t in card_texts)


def test_new_layouts_render_on_enterprise_master_too():
    """企业母版路径：章节分隔页/图表页/对比页都是自绘主体（客户模板不会自带这些占位符），
    不因为换了母版就整段消失或报错——同评分点角标/页码「母版不自带、恒定自绘」的既有约定。"""
    data = render_pptx(_rich_deck(), master_bytes=_tiny_master())
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 5
    assert any(sh.has_chart for sl in prs.slides for sh in sl.shapes)
    assert any(sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE and sh.auto_shape_type == MSO_SHAPE.ROUNDED_RECTANGLE
               for sl in prs.slides for sh in sl.shapes)


# ---- 评审回归：渲染层绝不能因为"内容形状特殊"整份崩掉 ----

def test_blank_stat_card_does_not_crash_the_render():
    """空串赋给 paragraph.text 不产生 run，取 runs[0] 会 IndexError → 付费导出确定性失败且重试
    无效（评审实测复现）。入口现在拒绝空卡片（StatItem 与 App PATCH 都要求非空），但**渲染层
    仍须自己防御**：库里可能已有旧数据，且导出每次都会重渲存量 deck——渲染层崩掉就再也导不出来。
    因此用 model_construct 绕过校验直接构造"历史脏数据"形状。"""
    from agent.agents.bidding_agent.schemas import StatItem
    blank = StatItem.model_construct(value="", label="")
    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "对比", "kind": "content", "layout": "comparison", "bullets": ["要点"]},
    ])
    deck.slides[0].stats = [blank]
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    assert len(prs.slides) == 1


def test_many_category_pie_does_not_crash_the_render():
    """报价构成/岗位分布这类饼图 7 个类别很常见。配色的混合比例不封顶会算出 >255 的通道值，
    RGBColor 直接抛 ValueError → 整个 present run 在模型已经花完钱之后失败（评审实测复现）。"""
    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "报价构成", "kind": "content", "layout": "chart",
         "chart": {"type": "pie", "categories": [f"项{i}" for i in range(9)],
                   "series": [{"name": "金额", "values": [1.0] * 9}]}},
    ])
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    assert any(sh.has_chart for sh in prs.slides[0].shapes)


def test_chart_page_renders_every_bullet_not_just_the_first():
    """提示词允许图表页带 1-2 句结论，编辑器也保存全部要点——只画 bullets[0] 等于用户写的
    第二句在 PPT 里凭空消失且毫无提示（评审）。"""
    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "团队", "kind": "content", "layout": "chart",
         "bullets": ["第一句结论", "第二句结论"],
         "chart": {"type": "pie", "categories": ["高级"], "series": [{"name": "人数", "values": [3]}]}},
    ])
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    texts = " ".join(_all_texts(prs))
    assert "第一句结论" in texts and "第二句结论" in texts


def test_new_layouts_fit_inside_a_four_by_three_master():
    """企业母版路径沿用客户自己的页面尺寸。新版式若按死写的 16:9 常量绘制，4:3 母版（10in 宽）
    下图表会被推出页面 2.63in（约四分之一被裁），页码则每页都跑到页面外（评审实测复现）。"""
    master = _tiny_master(width_in=10.0, height_in=7.5)
    deck = DeckSpec(title="述标", slides=[
        {"id": "sec", "title": "技术方案", "kind": "section", "bullets": ["过渡语"]},
        {"id": "s1", "title": "业绩", "kind": "content", "layout": "chart",
         "chart": {"type": "column", "categories": ["A", "B"], "series": [{"name": "n", "values": [1, 2]}]}},
        {"id": "s2", "title": "对比", "kind": "content", "layout": "comparison",
         "bullets": ["要点"], "stats": [{"value": "72 小时", "label": "提前完成"}]},
    ])
    prs = Presentation(io.BytesIO(render_pptx(deck, master_bytes=master)))
    assert prs.slide_width == Inches(10.0)
    overflow = [
        sh.left + sh.width
        for sl in prs.slides for sh in sl.shapes
        if sh.left is not None and sh.width is not None and sh.left + sh.width > prs.slide_width + Emu(9144)
    ]
    assert overflow == [], f"有形状超出母版页宽: {overflow}"


def test_chart_renders_even_when_the_model_omitted_the_layout_key():
    """端到端守住那次事故：deck 里带 chart 数据但 layout 缺省成 bullets 时，导出必须仍然渲出
    真实图表对象，而不是把数据丢掉只画要点（用户实际拿到的就是后者）。
    存量 deck 重新导出也走这条路径——库里已有的坏形状导出即自愈，无需重新生成。"""
    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "项目实施进度与团队配置", "kind": "content",
         "bullets": ["到货验收后 15 日内完成安装调试"],
         "chart": {"type": "column", "categories": ["安装", "调试", "培训"],
                   "series": [{"name": "工期(天)", "values": [5, 7, 3]}]}},
    ])
    assert deck.slides[0].layout == "chart"          # 数据即意图
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    charts = [sh for sh in prs.slides[0].shapes if sh.has_chart]
    assert len(charts) == 1, "图表数据在，导出就必须有真实图表对象"
    assert list(charts[0].chart.plots[0].categories) == ["安装", "调试", "培训"]


def _shapes_of(prs, idx=0):
    return list(prs.slides[idx].shapes)


def test_scoring_chip_is_wide_enough_for_chinese_and_never_bleeds_left():
    """用户实测：每一页左下角的评分点角标渲成「分点｜…」——「评」字被切在画面外。
    _chip_width 按 0.11in/字符估宽，而 12pt 中文字符实际约 0.167in：30 字标签估 3.3in、
    实需 ~4.7in，形状文字默认居中且 word_wrap=False，多出的 1.4in 往两边各溢出 0.7in，
    左边正好顶着页边距。宽度要按字符类型估，且文字左对齐——溢出只能往右，不能吃掉首字。"""
    from pptx.enum.text import PP_ALIGN
    from agent.agents.bidding_agent.render.pptx import _chip_width
    from pptx.util import Inches, Pt

    scoring = "★交货时间/地点/方式、★质保期、★知识产权与保密要求"
    text = f"评分点｜{scoring}"
    cjk = sum(1 for c in text if ord(c) > 0x2E80)
    # 12pt 中文 ≈ 12pt 宽 = 1/6 in；估宽必须覆盖真实文字宽度，否则必然溢出
    assert _chip_width(text) >= Inches(cjk / 6.0), "中文角标估宽不足，文字会溢出框外"

    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "核心需求", "kind": "content", "bullets": ["要点"], "scoring": scoring},
    ])
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    chips = [sh for sh in _shapes_of(prs)
             if sh.has_text_frame and sh.text_frame.text.startswith("评分点")]
    assert chips, "评分点角标没渲出来"
    chip = chips[0]
    assert chip.left >= 0
    assert chip.text_frame.paragraphs[0].alignment == PP_ALIGN.LEFT, "居中会让溢出吃掉左侧首字"


def test_bullets_fill_the_slide_instead_of_hugging_the_top():
    """用户反馈「太素」的一半原因：4 条要点只占顶部约 25%，下面 60% 是纯白。
    要点区固定 top=1.4in、顶对齐，内容少时下方全空。改成卡片等距铺开并整体垂直居中后，
    最后一张卡片必须越过页面中线，页面才不会头重脚轻。"""
    deck = DeckSpec(title="述标", slides=[
        {"id": "s1", "title": "核心需求理解", "kind": "content", "scoring": "技术方案 15 分",
         "bullets": ["承诺 30 日内交付", "3 年免费质保", "原厂全新正品", "全部★条款无偏离"]},
    ])
    prs = Presentation(io.BytesIO(render_pptx(deck)))
    mid = prs.slide_height / 2
    bodies = [sh for sh in _shapes_of(prs)
              if sh.has_text_frame and "质保" in sh.text_frame.text]
    assert bodies, "要点没渲出来"
    lowest = max(sh.top + sh.height for sh in bodies)
    assert lowest > mid, "要点全挤在上半页，下面一大片空白"


def _deck_for_style():
    return DeckSpec(title="述标", slides=[
        {"id": "c", "title": "封面", "kind": "cover", "bullets": []},
        {"id": "sec", "title": "第一部分 技术方案", "kind": "section", "bullets": []},
        {"id": "s1", "title": "核心需求", "kind": "content", "scoring": "技术方案 20 分",
         "bullets": ["要点一", "要点二", "要点三"]},
        {"id": "e", "title": "感谢聆听", "kind": "end", "bullets": []},
    ])


def _layout_signature(prs: Presentation, idx: int) -> tuple:
    """某一页的版式指纹：所有图形的尺寸集合。只换配色不换版式的话三套会撞成同一个指纹。"""
    return tuple(sorted((sh.width, sh.height) for sh in prs.slides[idx].shapes
                        if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE))


def test_three_templates_differ_in_layout_not_only_colour():
    """模板此前只差三个配色、版式完全一样，用户选来选去每页长得一模一样，等于没得选。
    这条锁住「换模板必须换版式」：封面（满幅/分栏/横幅）与正文页（overline/numeral/corner
    标题 + numbered/hairline/elevated 卡片）在三套之间都不能撞。"""
    covers, contents = {}, {}
    for tpl in ("blue", "gov", "tech"):
        prs = Presentation(io.BytesIO(render_pptx(_deck_for_style(), template=tpl)))
        covers[tpl] = _layout_signature(prs, 0)
        contents[tpl] = _layout_signature(prs, 2)
    assert len(set(covers.values())) == 3, f"三套封面版式没有区分：{covers}"
    assert len(set(contents.values())) == 3, f"三套正文版式没有区分：{contents}"


def test_unknown_layout_switches_fall_back_to_the_default_painters(monkeypatch):
    """结构开关是枚举：token 里写了渲染层不认识的取值（改名/手写脏数据/未来新模板漏登记画法），
    必须静默回退到默认那套画法，而不是 KeyError 让整份述标导不出来。"""
    from agent.agents.bidding_agent.render import styles
    bogus = dict(_TEMPLATE_TOKENS["blue"], header="???", card="???", cover="???")
    monkeypatch.setitem(styles.TEMPLATE_TOKENS, "bogus", bogus)
    prs = Presentation(io.BytesIO(render_pptx(_deck_for_style(), template="bogus")))
    ref = Presentation(io.BytesIO(render_pptx(_deck_for_style(), template="blue")))
    assert len(prs.slides) == len(ref.slides)
    for idx in range(len(ref.slides)):
        assert _layout_signature(prs, idx) == _layout_signature(ref, idx), f"第 {idx} 页没有回退到默认版式"


def _rel_luminance(rgb: RGBColor) -> float:
    def channel(v: int) -> float:
        c = v / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _contrast(a: RGBColor, b: RGBColor) -> float:
    la, lb = _rel_luminance(a), _rel_luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def test_every_template_keeps_its_text_readable_on_its_own_ground():
    """三套模板的每一对「字色 × 它实际压着的底色」都要过 4.5:1（正文/弱化字/主色块反白/
    卡片与角标）。投影仪比屏幕更不宽容，浅底那套颜色搬到深底上就是一团糊——深色模板的
    on_primary 不是白色正是为了这条。"""
    from agent.agents.bidding_agent.render.styles import on_primary
    for name, t in _TEMPLATE_TOKENS.items():
        pairs = {
            "正文/页底": (t["text"], t["bg"]),
            "弱化字/页底": (t["muted"], t["bg"]),
            "主色块反白": (on_primary(t), t["primary"]),
            "强调色/卡片底": (t["accent"], t["tint"]),
            "正文/卡片底": (t["text"], t["tint"]),
        }
        for label, (fg, bg) in pairs.items():
            ratio = _contrast(fg, bg)
            assert ratio >= 4.5, f"{name} 的「{label}」对比度只有 {ratio:.2f}:1，投影上会糊"


def test_dark_template_paints_a_background_and_light_text():
    """深色模板必须真的铺底色并把正文改成浅色——只改强调色的话，深色主题的字仍是深灰，
    在白底上看不出区别，在深底上则糊成一片。"""
    prs = Presentation(io.BytesIO(render_pptx(_deck_for_style(), template="tech")))
    content = prs.slides[2]
    slide_w, slide_h = prs.slide_width, prs.slide_height
    full = [sh for sh in content.shapes
            if sh.width == slide_w and sh.height == slide_h and sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE]
    assert full, "深色模板没有铺满整页的底色块"
    assert full[0].fill.fore_color.rgb == RGBColor(15, 23, 42)
    body = [sh for sh in content.shapes if sh.has_text_frame and sh.text_frame.text == "要点一"]
    assert body, "要点没渲出来"
    colour = body[0].text_frame.paragraphs[0].runs[0].font.color.rgb
    assert colour == RGBColor(226, 232, 240), f"深底上的正文色仍是浅底那套：{colour}"


def test_light_templates_do_not_paint_a_background():
    """浅色模板不铺整页底色：空白版式本来就是白底，多画一层只会让文件变大、还可能盖住母版元素。
    （封面是例外：满幅/横幅封面本来就要一块自己的底，所以只看正文页。）"""
    for tpl in ("blue", "gov"):
        prs = Presentation(io.BytesIO(render_pptx(_deck_for_style(), template=tpl)))
        content = prs.slides[2]
        full = [sh for sh in content.shapes
                if sh.width == prs.slide_width and sh.height == prs.slide_height]
        assert not full, f"{tpl} 不该铺整页底色"


def _full_deck():
    """一份把所有版式都用上的 deck：封面/分隔页/要点页/饼图页/多系列柱图页/对比页/结束页。"""
    return DeckSpec(title="某市政务云平台运维服务项目", slides=[
        {"id": "c", "kind": "cover", "title": "某市政务云平台运维服务项目",
         "bullets": ["投标人：某科技股份有限公司", "述标时长 15 分钟"]},
        {"id": "sec", "kind": "section", "title": "项目理解与总体方案", "bullets": ["逐条对应评分办法"]},
        {"id": "b", "kind": "content", "title": "核心需求理解", "scoring": "★服务范围 20 分",
         "bullets": ["7×24 驻场值守", "一级故障 2 小时恢复", "全部★条款无偏离"], "notes": "口播稿"},
        {"id": "p", "kind": "content", "title": "团队构成", "layout": "chart", "scoring": "团队 15 分",
         "bullets": ["中级及以上职称占比 60%"],
         "chart": {"type": "pie", "categories": ["高级", "中级", "初级"],
                   "series": [{"name": "人数", "values": [3, 6, 4]}]}},
        {"id": "col", "kind": "content", "title": "三年投入", "layout": "chart",
         "chart": {"type": "column", "categories": ["2024", "2025", "2026"],
                   "series": [{"name": "人月", "values": [96, 132, 156]},
                              {"name": "巡检", "values": [48, 60, 72]}]}},
        {"id": "cmp", "kind": "content", "title": "承诺优于要求", "layout": "comparison",
         "scoring": "★服务承诺 15 分", "bullets": ["恢复时限提前 50%", "质保 3 年"],
         "stats": [{"value": "2 小时", "label": "一级故障恢复"}, {"value": "0 起", "label": "质量投诉"}]},
        {"id": "e", "kind": "end", "title": "感谢聆听"},
    ])


def test_every_template_renders_every_layout_and_reopens():
    """三套 × 全版式（图表/对比/要点/分隔/封面/结束）都要能渲出来、能被重新打开、每页有形状。
    这是模板改版的兜底回归：换了骨架不能有哪一套在某个版式上画不出东西或直接抛异常。"""
    for tpl in ("blue", "tech", "gov"):
        data = render_pptx(_full_deck(), template=tpl)
        assert data[:2] == b"PK"
        prs = Presentation(io.BytesIO(data))
        assert len(prs.slides) == 7
        for i, slide in enumerate(prs.slides):
            assert len(slide.shapes) > 0, f"{tpl} 第 {i} 页是空页"
        assert sum(1 for sl in prs.slides for sh in sl.shapes if sh.has_chart) == 2
        texts = " ".join(_all_texts(prs))
        assert "核心需求理解" in texts and "承诺优于要求" in texts


def _master_without_placeholders(width_in: float = 10.0, height_in: float = 7.5) -> bytes:
    """把首个版式的占位符全部摘掉的迷你母版：客户母版里这种「纯图形版式」很常见，
    此时封面/结束页会退回我们自己的画法——新封面骨架正是在这条路径上才会被画出来。"""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(width_in), Inches(height_in)
    layout = prs.slide_layouts[0]
    for ph in list(layout.placeholders):
        ph._element.getparent().remove(ph._element)
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def test_covers_fall_back_to_our_own_painting_on_a_placeholderless_master():
    """母版没有标题占位符时，封面/结束页整页退回我们自己的画法——三套的新封面骨架
    （满幅/分栏/横幅）都得在客户自己的页面尺寸里画完，一寸都不能出界。"""
    master = _master_without_placeholders(width_in=10.0, height_in=7.5)
    for tpl in ("blue", "tech", "gov"):
        prs = Presentation(io.BytesIO(render_pptx(_full_deck(), template=tpl, master_bytes=master)))
        cover = prs.slides[0]
        assert any(sh.has_text_frame and "某市政务云平台运维服务项目" in sh.text_frame.text
                   for sh in cover.shapes), f"{tpl} 封面没画出来"
        slop = Emu(9144)
        over = [(sh.left, sh.width) for sh in cover.shapes
                if sh.left + sh.width > prs.slide_width + slop or sh.left < -slop]
        assert over == [], f"{tpl} 的封面在窄母版上画出界：{over}"


def test_every_template_fits_inside_a_narrow_enterprise_master():
    """企业母版路径 × 三套模板：新骨架（角标/分栏封面/横幅封面）一律按真实页宽页高定位，
    在 4:3 母版（10in 宽）上不许有任何形状越过页边——死写 16:9 常量就会每页被裁掉一截。"""
    master = _tiny_master(width_in=10.0, height_in=7.5)
    for tpl in ("blue", "tech", "gov"):
        prs = Presentation(io.BytesIO(render_pptx(_full_deck(), template=tpl, master_bytes=master)))
        assert prs.slide_width == Inches(10.0)
        assert len(prs.slides) == 7
        slop = Emu(9144)      # 0.01in：形状边框宽度级别的容差
        over = [(i, sh.shape_type, sh.left + sh.width, sh.top + sh.height)
                for i, sl in enumerate(prs.slides) for sh in sl.shapes
                if sh.left is not None and sh.width is not None
                and (sh.left + sh.width > prs.slide_width + slop
                     or sh.top + sh.height > prs.slide_height + slop
                     or sh.left < -slop or sh.top < -slop)]
        assert over == [], f"{tpl} 在 4:3 母版上画出界：{over}"
