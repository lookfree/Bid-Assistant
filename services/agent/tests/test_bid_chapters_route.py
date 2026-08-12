"""线下标书分章路由：供审查报告点回标书原文。"""
from agent.routes.bid_chapters import _shape


def test_keeps_document_order():
    """章序 = 文件与章节的原始顺序。乱序的话「第三章」排在「第一章」前面，用户以为标书写乱了。"""
    got, _ = _shape({"第一章 商务响应": "甲", "第二章 技术方案": "乙", "第三章 报价": "丙"})
    assert [c["title"] for c in got] == ["第一章 商务响应", "第二章 技术方案", "第三章 报价"]


def test_a_huge_chapter_is_truncated_not_dropped():
    """超长章截断而不是丢掉：丢掉的话那一章的风险项就永远跳不过去了。"""
    got, truncated = _shape({"技术方案": "字" * 50_000})
    assert truncated is True
    assert len(got) == 1 and len(got[0]["text"]) == 20_000


def test_total_cap_stops_before_blowing_the_response():
    """一份 366 页标书纯文本可达数十万字，整篇过网既慢又没人读得完。"""
    got, truncated = _shape({f"第{i}章": "字" * 20_000 for i in range(1, 40)})
    assert truncated is True
    assert sum(len(c["text"]) for c in got) <= 400_000


def test_blank_chapters_survive_as_empty_text():
    """扫描页那种「解析不出文字」的章要留着占位——它在标书里真实存在，
    删掉会让用户以为漏了一章（本路由刻意不跑 OCR，见模块 docstring）。"""
    got, _ = _shape({"资格证明文件": "   ", "技术方案": "正文"})
    assert [c["title"] for c in got] == ["资格证明文件", "技术方案"]
    assert got[0]["text"] == ""
