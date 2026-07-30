import io
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.util import Emu, Inches
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.render.pptx import render_pptx, _TEMPLATE_TOKENS


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


def test_cover_has_primary_band_and_40pt_title():
    deck = _deck()
    data = render_pptx(deck, template="blue")
    prs = Presentation(io.BytesIO(data))
    cover = prs.slides[0]
    band_rects = [sh for sh in cover.shapes if sh.shape_type == MSO_SHAPE.RECTANGLE]
    assert any(sh.fill.fore_color.rgb == _TEMPLATE_TOKENS["blue"]["primary"] for sh in band_rects)
    title_box = next(sh for sh in cover.shapes if sh.has_text_frame and sh.text_frame.text == "封面")
    run = title_box.text_frame.paragraphs[0].runs[0]
    assert run.font.size.pt == 40
    assert run.font.bold is True
    assert run.font.color.rgb == RGBColor(0xFF, 0xFF, 0xFF)


def test_content_slide_bullets_and_scoring_chip():
    data = render_pptx(_deck())
    prs = Presentation(io.BytesIO(data))
    content = prs.slides[1]
    body = next(sh for sh in content.shapes
                if sh.has_text_frame and sh.text_frame.paragraphs[0].text.startswith("• "))
    paras = body.text_frame.paragraphs
    assert len(paras) == 3
    for p in paras:
        assert p.runs[0].font.size.pt == 16
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
