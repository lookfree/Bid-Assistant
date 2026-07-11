from agent.parsing.merge import merge_parsed
from agent.parsing.types import ParsedDoc


def _doc(clauses: list[dict]) -> ParsedDoc:
    return ParsedDoc(text="", kind="docx", clauses=clauses)


def test_merge_identity_single_doc():
    """单文件=恒等变换（Global Constraint：单文件行为逐字节不变）。"""
    clauses = [{"id": "sec-1-c1", "text": "a"}, {"id": "sec-2-c1", "text": "b"}]
    merged, ranges = merge_parsed([("t.docx", _doc(clauses))])
    assert merged == clauses
    assert ranges == [{"name": "t.docx", "sec_from": 1, "sec_to": 2}]


def test_merge_offsets_second_doc_sections():
    doc1 = [{"id": "sec-1-c1", "text": "a"}, {"id": "sec-2-c1", "text": "b"}]
    doc2 = [{"id": "sec-1-c1", "text": "c"}, {"id": "sec-1-c2", "text": "d"}]
    merged, ranges = merge_parsed([("公告.docx", _doc(doc1)), ("技术规范.pdf", _doc(doc2))])
    assert merged == [
        {"id": "sec-1-c1", "text": "a"},
        {"id": "sec-2-c1", "text": "b"},
        {"id": "sec-3-c1", "text": "c"},
        {"id": "sec-3-c2", "text": "d"},
    ]
    assert ranges == [
        {"name": "公告.docx", "sec_from": 1, "sec_to": 2},
        {"name": "技术规范.pdf", "sec_from": 3, "sec_to": 3},
    ]


def test_merge_three_docs_cumulative_offset():
    doc1 = [{"id": "sec-1-c1", "text": "a"}]
    doc2 = [{"id": "sec-1-c1", "text": "b"}, {"id": "sec-2-c1", "text": "c"}]
    doc3 = [{"id": "sec-1-c1", "text": "d"}]
    merged, ranges = merge_parsed([("f1", _doc(doc1)), ("f2", _doc(doc2)), ("f3", _doc(doc3))])
    assert [c["id"] for c in merged] == ["sec-1-c1", "sec-2-c1", "sec-3-c1", "sec-4-c1"]
    assert ranges == [
        {"name": "f1", "sec_from": 1, "sec_to": 1},
        {"name": "f2", "sec_from": 2, "sec_to": 3},
        {"name": "f3", "sec_from": 4, "sec_to": 4},
    ]


def test_merge_empty_doc_list_gives_empty_result():
    merged, ranges = merge_parsed([])
    assert merged == [] and ranges == []
