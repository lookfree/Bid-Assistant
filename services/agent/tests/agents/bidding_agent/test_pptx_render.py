import io
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
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


def test_render_on_master_malformed_bytes_falls_back_to_blank():
    data = render_pptx(_deck(), master_bytes=b"not a pptx")
    assert data[:2] == b"PK"
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 3
    assert prs.slide_width == Emu(12192000)      # 回退空白设计：强制 16:9
