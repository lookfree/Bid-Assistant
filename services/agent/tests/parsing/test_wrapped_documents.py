"""扩展名对、内容不对的文件（文档加密软件封装 / 下载不完整 / 改错扩展名）。

生产实测（2026-08-05）：一份 7.6MB 的 .pdf 文件头是 `%TSD-Header-###%`、无 `%%EOF`，
是被文档透明加密（DLP）软件封装成的密文。pypdf 抛 "Stream has ended unexpectedly"，
读标据此降级到「让模型自己调 parse_document」的兜底路径，烧掉四轮 token 后抛出
「模型未通过 submit_read_result 提交结构化结果」——把一个文件问题报成了模型问题。
"""
from __future__ import annotations

import pytest

from agent.parsing.parsers import parse_bytes
from agent.parsing.types import UnsupportedDocument

TSD_HEADER = b"%TSD-Header-###%"


def test_dlp_wrapped_pdf_names_the_encryption():
    """加密封装的 .pdf：报错要点名「被加密软件封装」并给出可执行的下一步，不能只说「损坏」。"""
    data = TSD_HEADER + b"\x00\xd5\xff" * 500
    with pytest.raises(UnsupportedDocument) as ei:
        parse_bytes(data, "招标文件.pdf")
    msg = str(ei.value)
    assert "加密" in msg
    assert "解密" in msg or "外发" in msg     # 必须告诉用户怎么办


def test_dlp_wrapped_docx_also_caught():
    """同一封装头出现在 .docx 上一样要认出来（封装与原格式无关）。"""
    with pytest.raises(UnsupportedDocument) as ei:
        parse_bytes(TSD_HEADER + b"rubbish", "招标文件.docx")
    assert "加密" in str(ei.value)


@pytest.mark.parametrize("name", ["a.pdf", "a.docx", "a.xlsx"])
def test_content_extension_mismatch_is_explicit(name):
    """内容与扩展名不符（截断下载、改错扩展名）：报错要说清是「内容与扩展名不符」。"""
    with pytest.raises(UnsupportedDocument) as ei:
        parse_bytes(b"just some plain text, definitely not a document", name)
    assert "扩展名" in str(ei.value)


def test_real_documents_still_parse(docgen):
    """回归护栏：真文件不能被魔数校验误伤。"""
    assert parse_bytes(docgen.docx("第一章 总则", "投标保证金为人民币两万元"), "a.docx").clauses
    assert parse_bytes(docgen.xlsx(), "a.xlsx").clauses
    assert parse_bytes(docgen.pdf("Chapter 1"), "a.pdf") is not None


def test_pdf_with_leading_junk_still_parses(docgen):
    """PDF 规范容忍文件头前有少量前导字节，pypdf 也容忍——魔数校验不能比解析器更严。"""
    assert parse_bytes(b"\n\n" + docgen.pdf("Chapter 1"), "a.pdf") is not None
