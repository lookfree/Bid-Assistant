import io
import uuid
from agent.parsing.service import read_and_parse
from agent.parsing.storage_read import _put_bytes, _delete


def _docx_bytes(text: str) -> bytes:
    from docx import Document
    d = Document()
    d.add_paragraph(text)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_read_and_parse_from_minio():
    key = f"uploads/test/{uuid.uuid4()}/tender.docx"
    _put_bytes(key, _docx_bytes("招标编号 ZB-2026-001"))
    try:
        doc = read_and_parse(key)
        assert doc.kind == "docx" and "ZB-2026-001" in doc.text
    finally:
        _delete(key)
