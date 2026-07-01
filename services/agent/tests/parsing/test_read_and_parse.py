import asyncio
import uuid
from agent.parsing.service import read_and_parse
from agent.parsing.tool import _parse_document
from agent.parsing.storage_read import _put_bytes, _delete


def test_read_and_parse_from_minio(docgen):
    key = f"uploads/test/{uuid.uuid4()}/tender.docx"
    _put_bytes(key, docgen.docx("招标编号 ZB-2026-001"))
    try:
        doc = read_and_parse(key)
        assert doc.kind == "docx" and "ZB-2026-001" in doc.text
    finally:
        _delete(key)


def test_parse_document_tool_inlines_clause_ids(docgen):
    key = f"uploads/test/{uuid.uuid4()}/t.docx"
    _put_bytes(key, docgen.docx("第一章 资格要求", "投标人须具备信息系统集成资质"))
    try:
        out = asyncio.run(_parse_document(key))
        assert "[sec-" in out and "投标人须具备信息系统集成资质" in out   # 条款 id 内联，模型可引用
    finally:
        _delete(key)
