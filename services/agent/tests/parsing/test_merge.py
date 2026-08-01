from agent.parsing.merge import merge_parsed
from agent.parsing.types import ParsedDoc


def _doc(clauses: list[dict], headings: list[dict] | None = None) -> ParsedDoc:
    return ParsedDoc(text="", kind="docx", clauses=clauses, headings=headings or [])


def test_merge_identity_single_doc():
    """单文件=恒等变换（Global Constraint：单文件行为逐字节不变）。"""
    clauses = [{"id": "sec-1-c1", "text": "a"}, {"id": "sec-2-c1", "text": "b"}]
    merged, ranges, _ = merge_parsed([("t.docx", _doc(clauses))])
    assert merged == clauses
    assert ranges == [{"name": "t.docx", "sec_from": 1, "sec_to": 2}]


def test_merge_offsets_second_doc_sections():
    doc1 = [{"id": "sec-1-c1", "text": "a"}, {"id": "sec-2-c1", "text": "b"}]
    doc2 = [{"id": "sec-1-c1", "text": "c"}, {"id": "sec-1-c2", "text": "d"}]
    merged, ranges, _ = merge_parsed([("公告.docx", _doc(doc1)), ("技术规范.pdf", _doc(doc2))])
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
    merged, ranges, _ = merge_parsed([("f1", _doc(doc1)), ("f2", _doc(doc2)), ("f3", _doc(doc3))])
    assert [c["id"] for c in merged] == ["sec-1-c1", "sec-2-c1", "sec-3-c1", "sec-4-c1"]
    assert ranges == [
        {"name": "f1", "sec_from": 1, "sec_to": 1},
        {"name": "f2", "sec_from": 2, "sec_to": 3},
        {"name": "f3", "sec_from": 4, "sec_to": 4},
    ]


def test_merge_empty_doc_list_gives_empty_result():
    merged, ranges, _ = merge_parsed([])
    assert merged == [] and ranges == []


def test_merge_offsets_headings_with_the_same_shift():
    """章节标题必须跟 clauses 用**同一套偏移**重排：不重排的话，第 2 份起的标题会挂到前一份的
    节上——左栏显示的标题与其下正文对不上号，而这种错看起来只像「标题写错了」，很难查。"""
    doc1 = [{"id": "sec-1-c1", "text": "a"}, {"id": "sec-2-c1", "text": "b"}]
    doc2 = [{"id": "sec-1-c1", "text": "c"}]
    h1 = [{"sec": "sec-1", "title": "第一章 投标须知", "level": 1}]
    h2 = [{"sec": "sec-1", "title": "第一章 技术规格", "level": 1}]
    _, _, headings = merge_parsed([("公告.docx", _doc(doc1, h1)), ("规范.pdf", _doc(doc2, h2))])
    assert headings == [
        {"sec": "sec-1", "title": "第一章 投标须知", "level": 1},
        {"sec": "sec-3", "title": "第一章 技术规格", "level": 1},   # 前一份占了 sec-1/sec-2
    ]
