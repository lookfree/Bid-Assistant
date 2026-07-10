"""spec316 A1: chunker 边界——纯函数,无副作用,重点单测。"""
from agent.rag.chunker import MAX_CHARS, OVERLAP, chunk


def test_empty_text_returns_empty_list():
    assert chunk("") == []
    assert chunk("   \n\n  ") == []


def test_short_text_returns_single_chunk():
    text = "投标人应具备建筑工程施工总承包壹级资质。"
    result = chunk(text)
    assert result == [text]


def test_long_text_splits_into_multiple_chunks_with_overlap():
    # 3 段落，每段刚好 300 字，总 900 字 > 500，必然跨块
    paragraphs = ["甲" * 300, "乙" * 300, "丙" * 300]
    text = "\n\n".join(paragraphs)
    result = chunk(text)
    assert len(result) > 1
    for c in result:
        assert len(c) <= MAX_CHARS + OVERLAP
    # 相邻块首尾重叠 OVERLAP 字符
    for i in range(1, len(result)):
        assert result[i][:OVERLAP] == result[i - 1][-OVERLAP:]


def test_overlong_single_paragraph_is_hard_split():
    text = "甲" * 1200  # 单段落,无换行,远超 MAX_CHARS
    result = chunk(text)
    assert len(result) > 1
    for c in result:
        assert len(c) <= MAX_CHARS + OVERLAP
    # 原文内容完整出现（去重叠后拼接应能还原全部字符，不丢字）
    assert "".join(result)[:MAX_CHARS] == text[:MAX_CHARS]


def test_chinese_paragraphs_split_by_blank_line_stay_whole_when_possible():
    # 段落本身不超长时，chunk 内部不应把一个段落从中间切开
    para_a = "公司成立于二零一零年，专注建筑工程施工总承包业务。" * 4   # ~220 字
    para_b = "近三年主持完成市政道路、桥梁及给排水工程共计十七项。" * 4   # ~220 字
    para_c = "拥有一级建造师十二名，安全生产许可证齐全，业绩优良。" * 4   # ~220 字
    text = "\n\n".join([para_a, para_b, para_c])
    result = chunk(text)
    # 段落各自完整地出现在某个 chunk 里（未被从中间截断）
    for para in (para_a, para_b, para_c):
        assert any(para in c for c in result)
