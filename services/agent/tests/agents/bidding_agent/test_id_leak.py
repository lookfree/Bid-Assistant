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
from agent.agents.bidding_agent.schemas import ReadResult, RiskFinding, Slide


class TestCleaner:
    @pytest.mark.parametrize("raw,expect_gone", [
        ("对应：评审办法（sec-2-c8）价格相同者优先", "sec-2-c8"),
        ("所有★关键条款（sec-54-c1、sec-58-c1）均完全满足", "sec-54"),          # 一组多个
        ("授权委托书（clause_ids: sec-12-c4~c5, sec-65-c122）", "clause_ids"),   # 区间 + 字段名
        ("<td>sec-37-c36~c37, sec-37-c39</td>", "sec-37"),                      # 表格单元格
        ("依据 sec-1-c2、sec-1-c3 编制", "sec-1"),
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
