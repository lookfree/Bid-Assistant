"""线下标书分章路由：供审查报告点回标书原文。

**用真实形状喂测试**：parse_bid_chapters 回的是 {"sec-1": "<h3>标题</h3><p>正文</p>…"}——
键是节 id、值是转义后的 HTML。上一版按 {标题: 正文} 捏了输入，于是整条链路（标题显示成
sec-1、正文显示成裸标签、按标题定位永远匹配不上）全绿通过（评审 2026-08-12 实证）。
"""
from html import escape

from agent.routes.bid_chapters import _shape, _split_chapter


def _chapter(title: str, *paras: str) -> str:
    """复刻 nodes/common._aggregate 的产出形状（含转义）。"""
    head = f"<h3>{escape(title, quote=False)}</h3>" if title else ""
    return head + "".join(f"<p>{escape(p, quote=False)}</p>" for p in paras)


REAL = {
    "sec-1": _chapter("第一章 商务响应", "我方接受招标文件全部条款。", "报价有效期 90 天。"),
    "sec-2": _chapter("第二章 技术方案", "响应时间<30分钟，可用率>99.9%。"),
}


class TestSplitChapter:
    def test_title_and_paragraphs_come_out_unescaped(self):
        """标书里「响应时间<30分钟」这类写法遍地都是，落库时被转义过，展示前必须还原。"""
        title, paras = _split_chapter(REAL["sec-2"])
        assert title == "第二章 技术方案"
        assert paras == ["响应时间<30分钟，可用率>99.9%。"]

    def test_a_section_without_a_title_still_yields_its_paragraphs(self):
        title, paras = _split_chapter("<p>没有标题的一节</p>")
        assert title == "" and paras == ["没有标题的一节"]

    def test_empty_html_does_not_raise(self):
        assert _split_chapter("") == ("", [])


class TestShape:
    def test_section_ids_are_carried_through(self):
        """sec-N 正是审查结论 target_id 要求原样照抄的键——丢了它，精确定位就没了。"""
        got, _ = _shape(REAL)
        assert [c["sec"] for c in got] == ["sec-1", "sec-2"]
        assert [c["title"] for c in got] == ["第一章 商务响应", "第二章 技术方案"]

    def test_paragraphs_are_a_list_not_one_blob(self):
        """整章一坨的话，章内定位就只能落在开头，点哪条都跳同一个地方。"""
        got, _ = _shape(REAL)
        assert got[0]["paragraphs"] == ["我方接受招标文件全部条款。", "报价有效期 90 天。"]

    def test_document_order_is_kept(self):
        got, _ = _shape({"sec-1": _chapter("甲"), "sec-2": _chapter("乙"), "sec-3": _chapter("丙")})
        assert [c["title"] for c in got] == ["甲", "乙", "丙"]

    def test_an_oversized_chapter_is_trimmed_but_still_listed(self):
        got, truncated = _shape({"sec-1": _chapter("技术方案", *["字" * 5_000] * 10)})
        assert truncated is True
        assert len(got) == 1 and sum(len(p) for p in got[0]["paragraphs"]) <= 20_000

    def test_chapters_past_the_total_cap_are_still_listed(self):
        """整章丢掉的话，落在它里面的风险项永远跳不过去，前端还会显示「未能定位」——
        那是假消息，章根本没送到。"""
        got, truncated = _shape({f"sec-{i}": _chapter(f"第{i}章", "字" * 20_000) for i in range(1, 40)})
        assert truncated is True
        assert len(got) == 39, "超出总量上限的章被整章丢掉了"
        assert sum(len(p) for c in got for p in c["paragraphs"]) <= 400_000
