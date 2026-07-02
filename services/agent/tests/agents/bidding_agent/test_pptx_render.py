import io
from pptx import Presentation
from agent.agents.bidding_agent.schemas import DeckSpec
from agent.agents.bidding_agent.render.pptx import render_pptx


def test_render_pptx_produces_valid_deck():
    deck = DeckSpec(title="述标", slides=[
        {"id": "s0", "title": "封面", "kind": "cover"},
        {"id": "s1", "title": "运维体系", "bullets": ["7×24", "分级 SLA"],
         "scoring": "技术方案 50 分", "notes": "讲稿…", "kind": "content"},
    ])
    data = render_pptx(deck)
    assert data[:2] == b"PK"                       # .pptx 是 zip
    prs = Presentation(io.BytesIO(data))
    assert len(prs.slides) == 2
    assert prs.slides[1].notes_slide.notes_text_frame.text == "讲稿…"
