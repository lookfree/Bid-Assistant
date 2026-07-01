import io
import re
from agent.parsing.parsers import parse_bytes
from agent.parsing.types import UnsupportedDocument
import pytest


def _docx_bytes(text: str) -> bytes:
    from docx import Document
    d = Document()
    d.add_paragraph(text)
    d.add_paragraph("第二段")
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _xlsx_bytes() -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["评分项", "分值"])
    ws.append(["技术标", 60])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _pdf_bytes(text: str) -> bytes:
    from fpdf import FPDF
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("helvetica", size=12)
    pdf.cell(0, 10, text)
    return bytes(pdf.output())


def test_parse_docx():
    doc = parse_bytes(_docx_bytes("招标文件正文"), "tender.docx")
    assert doc.kind == "docx" and "招标文件正文" in doc.text and "第二段" in doc.text


def test_parse_xlsx_text_and_tables():
    doc = parse_bytes(_xlsx_bytes(), "score.xlsx")
    assert doc.kind == "xlsx" and "技术标" in doc.text
    assert doc.tables and doc.tables[0][0][0] == "评分项"


def test_parse_pdf():
    doc = parse_bytes(_pdf_bytes("Tender PDF Body"), "t.pdf")
    assert doc.kind == "pdf" and doc.pages == 1 and "Tender PDF Body" in doc.text


def test_clauses_have_stable_ids():
    doc = parse_bytes(_docx_bytes("招标文件正文"), "tender.docx")
    assert doc.clauses and re.match(r"^sec-.+-c1$", doc.clauses[0]["id"])
    assert doc.clauses[0]["text"] == "招标文件正文"


def test_unsupported_type_raises():
    with pytest.raises(UnsupportedDocument):
        parse_bytes(b"x", "a.zip")
