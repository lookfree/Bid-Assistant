"""内部条款 id 不许出现在任何给用户看的产物里。

2026-08-08 全量扫描线上产物，**四处都在漏**：
  审查报告 115 处 —— 「对应：评审办法（sec-2-c8）价格相同以案例居多者排名优先」
  正文        3 处 —— 连表格单元格里都写着「sec-37-c36~c37」，那是要交给评委的标书
  述标        1 处 —— 「所有★关键条款（sec-54-c1、sec-58-c1）均完全满足」
  读标        1 处 —— 「★条款不允许负偏离…（sec-33-c28, sec-75-c2）」
根因同一个：喂给模型的读标结论里带 clause_ids，模型顺手抄进了给人看的文字。
提示词里禁止只是"请模型配合"，确定性清洗才是能保证的那一半。
"""
import pytest

from agent.agents.bidding_agent.render.sanitize import clean_internal_ids
from agent.agents.bidding_agent.schemas import ReadResult, RiskFinding, RiskReport, Slide


class TestCleaner:
    @pytest.mark.parametrize("raw,expect_gone", [
        ("对应：评审办法（sec-2-c8）价格相同者优先", "sec-2-c8"),
        ("所有★关键条款（sec-54-c1、sec-58-c1）均完全满足", "sec-54"),          # 一组多个
        ("授权委托书（clause_ids: sec-12-c4~c5, sec-65-c122）", "clause_ids"),   # 区间 + 字段名
        ("<td>sec-37-c36~c37, sec-37-c39</td>", "sec-37"),                      # 表格单元格
        ("依据 sec-1-c2、sec-1-c3 编制", "sec-1"),
        ("技术规格（sec-55-c11~sec-55-c20）不符", "sec-55"),   # 区间两端都写全
        ("供应商情况一览表缺失——required_structure 构成项未提供", "required_structure"),
    ])
    def test_identifiers_are_removed(self, raw, expect_gone):
        assert expect_gone not in clean_internal_ids(raw)

    @pytest.mark.parametrize("raw", [
        "报价明细表产地/品牌与技术响应表一致性未体现",
        "甲、乙、丙三方共同承担",                 # 正常顿号不能被吃掉
        "服务期 3 年（含质保）",                  # 正常括号不能被吃掉
        "<td>三年</td>",
    ])
    def test_normal_text_is_untouched(self, raw):
        assert clean_internal_ids(raw) == raw

    def test_full_range_leaves_no_empty_parens(self):
        """两端都写全的区间要当成一组抹掉；只认缩写会留下「（~）」。"""
        assert clean_internal_ids("技术规格（sec-55-c11~sec-55-c20）不符") == "技术规格不符"

    def test_three_or_more_ids_leave_no_separator_run(self):
        """三个以上编号连写，抹完只收末尾那个分隔符不够——会剩「：, 。」。"""
        assert clean_internal_ids("<p>对应条款：sec-6-c1, sec-6-c2, sec-6-c3。</p>") == ""
        assert clean_internal_ids("对应条款：sec-1-c1, sec-1-c2 见附件三") == "对应条款：见附件三"

    @pytest.mark.parametrize("raw,want", [
        # 编号列表起头于单元格/段首：左边界是标签的 >，不是冒号
        ("<td>sec-1-c1, sec-2-c1, sec-3-c1 均满足</td>", "<td>均满足</td>"),
        ("<p>sec-1-c1, sec-1-c2, sec-1-c3 详见附件</p>", "<p>详见附件</p>"),
        ("要求：sec-1-c1；sec-2-c1；sec-3-c1", "要求："),       # 分号分隔
    ])
    def test_separator_runs_at_other_boundaries(self, raw, want):
        assert clean_internal_ids(raw) == want

    @pytest.mark.parametrize("raw", [
        "<li>投标人须提供近三年财务报表；</li>",   # 合法的分号结尾
        "<p>说明：</p>",                          # 领起下文的标签，没有句末标点，不是空壳
        "<p><strong>说明：</strong>投标人应……</p>",
    ])
    def test_legit_punctuation_survives(self, raw):
        assert clean_internal_ids(raw) == raw

    def test_shell_paragraph_is_dropped(self):
        """内容全是编号的段落，抹完只剩「对应招标文件条款：。」——这段要印进交给评委的标书。"""
        html = "<h3>6.7 制造商授权书</h3><p>对应招标文件条款：sec-6-c1, sec-6-c2, sec-6-c3。</p><p>说明：详见附件</p>"
        assert clean_internal_ids(html) == "<h3>6.7 制造商授权书</h3><p>说明：详见附件</p>"

    def test_no_dangling_punctuation(self):
        """抹完不能留下「（、）」「<td>, </td>」这种残渣——比编号本身还难看。"""
        assert clean_internal_ids("所有★关键条款（sec-54-c1、sec-58-c1）均完全满足") == "所有★关键条款均完全满足"
        assert clean_internal_ids("<td>sec-37-c36, sec-37-c39</td>") == "<td></td>"


class TestAppliedEverywhere:
    """光有函数不够——四处都必须真的调用它。"""

    def test_review_finding(self):
        f = RiskFinding(level="高风险", tone="destructive", title="缺件（sec-8-c95）",
                        advice="补齐", target_tab="business", target_id="b1",
                        anchor_text="", tender_ref="对应：构成要求（sec-8-c95）")
        assert "sec-8-c95" not in f.title and "sec-8-c95" not in f.tender_ref

    def test_present_slide(self):
        s = Slide(id="s1", title="技术响应（sec-54-c1）",
                  bullets=["所有★条款（sec-54-c1、sec-58-c1）均满足"], notes="依据 sec-2-c8 编制")
        assert "sec-54-c1" not in s.title
        assert not any("sec-" in b for b in s.bullets)
        assert "sec-2-c8" not in s.notes

    def test_read_risk_summary(self):
        r = ReadResult(categories=[], risk_summary=["★条款不允许负偏离（sec-33-c28, sec-75-c2）"])
        assert not any("sec-" in x for x in r.risk_summary)

    def test_review_passed_items(self):
        """通过项和风险项一样直接显示给用户——第一版只清了风险项，漏了这个平级列表。"""
        r = RiskReport(score=80, items=[],
                       passed_items=["响应函已提供，含90天有效期承诺（sec-8-c10）"])
        assert not any("sec-" in p for p in r.passed_items)

    def test_read_item_value(self):
        from agent.agents.bidding_agent.schemas import ReadItem

        it = ReadItem(title="报价方式（sec-16-c49）", value="包干价（sec-16-c49）", clause_ids=["sec-16-c49"])
        assert "sec-" not in it.title and "sec-" not in it.value

    def test_slide_scoring_line(self):
        """这行印在述标页标题下面，抹完不能留下「； ★」这种空格残渣。"""
        s = Slide(id="s1", title="技术响应", scoring="sec-54-c1 ★关键条款响应；sec-58-c1 ★逐条响应")
        assert s.scoring == "★关键条款响应；★逐条响应"

    def test_read_clause_ids_field_is_kept(self):
        """**只清洗给人看的自然语言**：clause_ids 字段本身必须留着，前端靠它点回原文定位。"""
        from agent.agents.bidding_agent.schemas import ReadCategory, ReadItem

        r = ReadResult(categories=[ReadCategory(key="technical", title="技术要求", items=[
            ReadItem(title="国密", value="SM3", clause_ids=["sec-4-c9"])])])
        assert r.categories[0].items[0].clause_ids == ["sec-4-c9"]

    def test_content_collection_cleans(self):
        from agent.agents.bidding_agent.nodes.content import _collect_chapters

        out = _collect_chapters({"/chapters/t1.html": {"content": "<p>依据 sec-1-c2 编制</p>"}}, allowed={"t1"})
        assert "sec-1-c2" not in out["t1"]
