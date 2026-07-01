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
