"""审查喂给模型的正文预算。

2026-08-08 用户反馈两件事，都在同一张截图上：
① 「识别出的风险实际在响应文件里都有」——线下标书整本解析成 1 章共 75425 字，
   而当时每章上限 4000 字，模型只看到 **5%**，剩下 95% 全被判成"缺失"。
（②「内部编号泄露到用户可见文字」的守卫在 test_id_leak.py，那里覆盖审查/正文/述标/读标四处。）
"""
from agent.agents.bidding_agent.nodes.common import allocate_chapter_budget

TOTAL, FLOOR = 80_000, 1_000
# 截断处补的系统注记（裸「（截断）」会被审查模型当成用户文件里的残留物，见 SYSTEM_NOTE_PREFIX）
_NOTE = "…【系统注记·截断】"


class TestBudget:
    def test_single_huge_chapter_gets_the_whole_document(self):
        """线下标书常常整本一章。按每章固定上限截断时它只进去 5%——这正是误报的来源。"""
        out = allocate_chapter_budget({"sec-1": "字" * 75_425}, TOTAL, FLOOR)
        assert len(out["sec-1"]) == 75_425
        assert _NOTE not in out["sec-1"]

    def test_short_chapters_are_never_truncated(self):
        out = allocate_chapter_budget({f"c{i}": "字" * 500 for i in range(10)}, TOTAL, FLOOR)
        assert all(len(v) == 500 for v in out.values())

    def test_total_stays_within_budget(self):
        """预算是硬的：再多的内容也不能顶穿上下文窗。"""
        out = allocate_chapter_budget({f"c{i}": "字" * 50_000 for i in range(10)}, TOTAL, FLOOR)
        assert sum(len(v) for v in out.values()) <= TOTAL

    def test_budget_holds_when_short_and_long_are_mixed(self):
        """混合场景才走得到"短章释放额度"那条路：短章吃掉的额度必须从余量里扣，
        不扣的话长章会按满额再拿一份，总量翻倍顶穿上下文窗（纯长章的用例测不出这个）。"""
        texts = {f"s{i}": "字" * 7_000 for i in range(10)}
        texts["big"] = "字" * 200_000
        out = allocate_chapter_budget(texts, TOTAL, FLOOR)
        assert sum(len(v) for v in out.values()) <= TOTAL

    def test_slack_from_short_chapters_goes_to_long_ones(self):
        """短章占不满份额，省下的要匀给长章——否则长章白白被砍。"""
        out = allocate_chapter_budget({"a": "x" * 100, "b": "y" * 60_000, "c": "z" * 60_000}, TOTAL, FLOOR)
        assert len(out["a"]) == 100
        assert len(out["b"]) > 30_000, "短章省下的额度没有匀给长章"

    def test_truncation_is_marked(self):
        """截断处要留记号，否则模型会把半截当成写完了。"""
        out = allocate_chapter_budget({"c": "字" * 200_000}, TOTAL, FLOOR)
        assert out["c"].endswith(_NOTE)

    def test_empty_input(self):
        assert allocate_chapter_budget({}, TOTAL, FLOOR) == {}
