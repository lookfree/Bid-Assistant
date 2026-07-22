import re
from agent.parsing.parsers import parse_bytes
from agent.parsing.types import UnsupportedDocument
import pytest


def test_parse_docx(docgen):
    doc = parse_bytes(docgen.docx("招标文件正文", "第二段"), "tender.docx")
    assert doc.kind == "docx" and "招标文件正文" in doc.text and "第二段" in doc.text


def test_parse_xlsx_text_and_tables(docgen):
    doc = parse_bytes(docgen.xlsx(), "score.xlsx")
    assert doc.kind == "xlsx" and "技术标" in doc.text
    assert doc.tables and doc.tables[0][0][0] == "评分项"


def test_parse_pdf(docgen):
    doc = parse_bytes(docgen.pdf("Tender PDF Body"), "t.pdf")
    assert doc.kind == "pdf" and doc.pages == 1 and "Tender PDF Body" in doc.text


def test_clauses_have_stable_ids(docgen):
    doc = parse_bytes(docgen.docx("招标文件正文", "第二段"), "tender.docx")
    assert doc.clauses and re.match(r"^sec-.+-c1$", doc.clauses[0]["id"])
    assert doc.clauses[0]["text"] == "招标文件正文"


def test_unsupported_type_raises():
    with pytest.raises(UnsupportedDocument):
        parse_bytes(b"x", "a.zip")


def test_docx_clauses_include_table_rows_in_document_order():
    """2026-07-22 生产根因回归：招标模板排在表格里，条款分句必须含表格行且按文档顺序归节——
    否则格式章只剩标题占节号（sec 空洞），内容生成拿不到模板原文。"""
    import io
    from docx import Document
    from agent.parsing.parsers import parse_docx

    d = Document()
    d.add_paragraph("第一章 采购公告")
    d.add_paragraph("采购内容：渗透测试服务。")
    d.add_paragraph("第二章 应答文件格式")
    t = d.add_table(rows=2, cols=2)
    t.rows[0].cells[0].text = "法定代表人授权委托书"
    t.rows[0].cells[1].text = "致：____（采购人名称）"
    t.rows[1].cells[0].text = "应答人："
    t.rows[1].cells[1].text = "____（盖章）"
    d.add_paragraph("第三章 评审办法")
    d.add_paragraph("综合评分法。")
    buf = io.BytesIO()
    d.save(buf)

    parsed = parse_docx(buf.getvalue())
    by_id = {c["id"]: c["text"] for c in parsed.clauses}
    # 表格行成为第二章的条款（\t 连接单元格），且第三章顺延不错位
    sec2 = [t for i, t in by_id.items() if i.startswith("sec-2-")]
    assert any("授权委托书" in t for t in sec2)
    assert any("盖章" in t for t in sec2)
    sec3 = [t for i, t in by_id.items() if i.startswith("sec-3-")]
    assert sec3 == ["综合评分法。"]
