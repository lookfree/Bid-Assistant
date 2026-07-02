from __future__ import annotations
import io
from pptx import Presentation
from pptx.util import Pt
from agent.agents.bidding_agent.schemas import DeckSpec

# 模板 → 主色（RGB）。上色钩子预留：本 spec 先保证「DeckSpec → 合法 .pptx + 备注含口播稿」；
# 企业自有母版（enterprise_template_id）后续加载 .pptx 模板文件。
_TEMPLATE_RGB = {"blue": (0x1F, 0x4E, 0x79), "tech": (0x0E, 0x76, 0x90), "gov": (0xA8, 0x1E, 0x1E)}


def render_pptx(deck: DeckSpec, *, template: str | None = None) -> bytes:
    """DeckSpec → .pptx 字节（确定性，无 LLM，§4.2.1 两段式的渲染段）。
    封面/结束页用 title 版式，正文页空白版式；口播稿写入备注页。"""
    prs = Presentation()
    blank, title_only = prs.slide_layouts[6], prs.slide_layouts[5]
    for s in deck.slides:
        slide = prs.slides.add_slide(title_only if s.kind != "content" else blank)
        # 标题
        if slide.shapes.title is not None:
            slide.shapes.title.text = s.title
        else:
            tb = slide.shapes.add_textbox(Pt(40), Pt(30), Pt(640), Pt(60))
            tb.text_frame.text = s.title
        # 要点
        if s.bullets:
            body = slide.shapes.add_textbox(Pt(40), Pt(110), Pt(640), Pt(360)).text_frame
            body.text = s.bullets[0]
            for b in s.bullets[1:]:
                body.add_paragraph().text = b
        # 评分点角标
        if s.scoring:
            note = slide.shapes.add_textbox(Pt(40), Pt(480), Pt(640), Pt(30)).text_frame
            note.text = f"评分点：{s.scoring}"
        # 口播稿 → 备注页
        if s.notes:
            slide.notes_slide.notes_text_frame.text = s.notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()
