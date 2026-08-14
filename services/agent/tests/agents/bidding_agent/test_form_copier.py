"""表单章复印机 T3（spec 2026-08-14）：招标 docx 的表单节点区间深拷贝进导出文档。
版式（表格合并格/下划线/居中）靠**复制**保真，不是重建——这正是整条复印机路线的意义。"""
import io

import pytest

from agent.agents.bidding_agent.nodes.form_locate import FormSpan


def _tender_docx() -> bytes:
    """真实形态的招标表单页：居中抬头 + 致行 + 带合并格的表格 + 下划线空位落款。"""
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    d = Document()
    d.add_paragraph("前置说明段。")                                # body#0
    head = d.add_paragraph("供应商资格信用承诺函")                  # body#1 居中抬头
    head.alignment = WD_ALIGN_PARAGRAPH.CENTER
    d.add_paragraph("致（采购人）：云上（江西）安全技术有限公司")     # body#2
    t = d.add_table(rows=2, cols=3)                               # body#3
    t.cell(0, 0).merge(t.cell(0, 1))                              # 合并格
    t.cell(0, 0).text = "合计（大写）"
    t.cell(0, 2).text = "税率"
    t.cell(1, 0).text = "1"
    p = d.add_paragraph()                                          # body#4 下划线空位
    p.add_run("单位名称：")
    blank = p.add_run("____________")
    blank.underline = True
    d.add_paragraph("后续无关段。")                                # body#5
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


class TestExtract:
    def test_span_nodes_are_copied_with_layout_intact(self):
        """区间抽取的节点保留合并格/居中/下划线——逐属性断言，防「文字在版式丢」。"""
        from agent.agents.bidding_agent.render.form_copier import extract_form_nodes

        nodes = extract_form_nodes(_tender_docx(), FormSpan(1, 4, -1))
        assert len(nodes) == 4
        xml = "".join(__import__("lxml").etree.tostring(n, encoding="unicode") for n in nodes)
        assert "供应商资格信用承诺函" in xml and "云上（江西）安全技术有限公司" in xml
        assert 'w:val="center"' in xml                     # 抬头居中
        assert "gridSpan" in xml or "hMerge" in xml or "vMerge" in xml or "restart" in xml \
            or "w:merge" in xml or "continue" in xml       # 合并格痕迹（python-docx 用 gridSpan/vMerge）
        assert "<w:u " in xml or 'w:u w:val' in xml.replace("'", '"')   # 下划线空位
        assert "后续无关段" not in xml and "前置说明段" not in xml

    def test_out_of_range_span_is_rejected(self):
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(_tender_docx(), FormSpan(90, 99, -1))

    def test_numbered_list_in_span_falls_back(self):
        """区间里有编号列表（numPr 引用 numbering.xml）→ 拒收：光搬节点是悬空引用，
        Word 里编号会错乱。宁可回退 HTML 路线。"""
        from docx import Document
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)

        from docx.oxml import parse_xml

        d = Document()
        d.add_paragraph("表单头")
        p = d.add_paragraph("第一条")          # 真实 Word 编号列表在 pPr 里直挂 numPr
        p._p.get_or_add_pPr().append(parse_xml(
            '<w:numPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'))
        buf = io.BytesIO()
        d.save(buf)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(buf.getvalue(), FormSpan(0, 1, -1))

    def test_image_in_span_falls_back(self):
        """区间里有图片引用（blip 指媒体部件）→ 拒收，同理悬空。"""
        from docx import Document
        from PIL import Image
        from agent.agents.bidding_agent.render.form_copier import (
            CopierUnsupported, extract_form_nodes)

        d = Document()
        d.add_paragraph("表单头")
        img = io.BytesIO()
        Image.new("RGB", (8, 8), "white").save(img, format="PNG")
        img.seek(0)
        d.add_picture(img)
        buf = io.BytesIO()
        d.save(buf)
        with pytest.raises(CopierUnsupported):
            extract_form_nodes(buf.getvalue(), FormSpan(0, 1, -1))


class TestGraft:
    def test_grafted_nodes_land_before_sectpr_and_keep_text(self):
        """嫁接进输出文档：文本与结构原样、sectPr 仍在文档末尾（插错位置 Word 打不开）。"""
        from docx import Document
        from agent.agents.bidding_agent.render.form_copier import (
            extract_form_nodes, graft_nodes)

        nodes = extract_form_nodes(_tender_docx(), FormSpan(1, 4, -1))
        out = Document()
        out.add_heading("供应商资格信用承诺函", level=1)
        graft_nodes(out, nodes)
        texts = [p.text for p in out.paragraphs]
        assert "致（采购人）：云上（江西）安全技术有限公司" in texts
        assert len(out.tables) == 1 and out.tables[0].cell(0, 0).text == "合计（大写）"
        body_tags = [el.tag.rsplit("}", 1)[-1] for el in out.element.body.iterchildren()]
        assert body_tags[-1] == "sectPr"
