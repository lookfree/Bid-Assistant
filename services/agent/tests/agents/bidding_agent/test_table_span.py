"""HTML 表格的 colspan/rowspan 取值容错。

2026-08-06 生产事故：模型在正文里写出 `<td colspan="1" rowspan="wer">`，导出时
`int(cell.get("rowspan"))` 抛 ValueError，整步以一句英文 Python 异常失败。
用户连点 9 次导出，每次 0.2 秒就崩，既不知道哪出了问题也无从自救。
（当时未扣积分，cost 全为 0。）
"""
import pytest

from agent.agents.bidding_agent.render.docx import _span


class TestGarbage:
    @pytest.mark.parametrize("raw", ["wer", "", "  ", "auto", "1,2", None, "2.5", "①"])
    def test_unparsable_falls_back_to_one(self, raw):
        """解析不了一律按不合并处理——宁可表格少一次合并，也不能整本标书导不出来。"""
        assert _span(raw, 10) == 1

    @pytest.mark.parametrize("raw", ["0", "-3", 0, -1])
    def test_non_positive_falls_back_to_one(self, raw):
        assert _span(raw, 10) == 1


class TestNormal:
    @pytest.mark.parametrize("raw,expect", [("1", 1), ("2", 2), (3, 3), (" 4 ", 4)])
    def test_valid_values_pass_through(self, raw, expect):
        assert _span(raw, 10) == expect


class TestOversized:
    def test_absurd_span_is_capped_not_dropped(self):
        """模型笔误写出 rowspan="999"：按 1 处理会丢掉合并意图，按原值会撑出 999 行的表。
        夹到上限——那正是「合并到底」的意思。"""
        assert _span("999", 5) == 5

    def test_cap_of_one_still_yields_one(self):
        assert _span("999", 1) == 1
