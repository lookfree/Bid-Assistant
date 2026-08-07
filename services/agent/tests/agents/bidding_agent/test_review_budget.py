"""审查喂给模型的正文预算 + 用户可见文字里不许有内部标识。

2026-08-08 用户反馈两件事，都在同一张截图上：
① 「识别出的风险实际在响应文件里都有」——线下标书整本解析成 1 章共 75425 字，
   而当时每章上限 4000 字，模型只看到 **5%**，剩下 95% 全被判成"缺失"。
② 风险卡上写着「（sec-8-c95）」「——required_structure 构成项未提供」——
   前者是内部条款 id，后者是读标结果的**字段名**，用户只会当成乱码。
"""
from agent.agents.bidding_agent.nodes.common import allocate_chapter_budget
from agent.agents.bidding_agent.schemas import _clean_user_text

TOTAL, FLOOR = 80_000, 1_000


class TestBudget:
    def test_single_huge_chapter_gets_the_whole_document(self):
        """线下标书常常整本一章。按每章固定上限截断时它只进去 5%——这正是误报的来源。"""
        out = allocate_chapter_budget({"sec-1": "字" * 75_425}, TOTAL, FLOOR)
        assert len(out["sec-1"]) == 75_425
        assert "（截断）" not in out["sec-1"]

    def test_short_chapters_are_never_truncated(self):
        out = allocate_chapter_budget({f"c{i}": "字" * 500 for i in range(10)}, TOTAL, FLOOR)
        assert all(len(v) == 500 for v in out.values())

    def test_total_stays_within_budget(self):
        """预算是硬的：再多的内容也不能顶穿上下文窗。"""
        out = allocate_chapter_budget({f"c{i}": "字" * 50_000 for i in range(10)}, TOTAL, FLOOR)
        assert sum(len(v) for v in out.values()) <= TOTAL + 10 * len("…（截断）")

    def test_budget_holds_when_short_and_long_are_mixed(self):
        """混合场景才走得到"短章释放额度"那条路：短章吃掉的额度必须从余量里扣，
        不扣的话长章会按满额再拿一份，总量翻倍顶穿上下文窗（纯长章的用例测不出这个）。"""
        texts = {f"s{i}": "字" * 7_000 for i in range(10)}
        texts["big"] = "字" * 200_000
        out = allocate_chapter_budget(texts, TOTAL, FLOOR)
        assert sum(len(v) for v in out.values()) <= TOTAL + len("…（截断）")

    def test_slack_from_short_chapters_goes_to_long_ones(self):
        """短章占不满份额，省下的要匀给长章——否则长章白白被砍。"""
        out = allocate_chapter_budget({"a": "x" * 100, "b": "y" * 60_000, "c": "z" * 60_000}, TOTAL, FLOOR)
        assert len(out["a"]) == 100
        assert len(out["b"]) > 30_000, "短章省下的额度没有匀给长章"

    def test_truncation_is_marked(self):
        """截断处要留记号，否则模型会把半截当成写完了。"""
        out = allocate_chapter_budget({"c": "字" * 200_000}, TOTAL, FLOOR)
        assert out["c"].endswith("…（截断）")

    def test_empty_input(self):
        assert allocate_chapter_budget({}, TOTAL, FLOOR) == {}


class TestLeakCleaning:
    def test_clause_id_in_parentheses_is_removed(self):
        assert _clean_user_text("对应：响应文件构成要求（sec-8-c95）★不可偏离") == "对应：响应文件构成要求★不可偏离"

    def test_bare_clause_id_is_removed(self):
        assert "sec-2-c8" not in _clean_user_text("评审办法 sec-2-c8 价格相同者优先")

    def test_internal_field_names_are_removed(self):
        out = _clean_user_text("供应商情况一览表缺失——required_structure 构成项未提供")
        assert "required_structure" not in out
        assert out == "供应商情况一览表缺失——构成项未提供"

    def test_dangling_dash_is_cleaned(self):
        """字段名被抹掉后只剩「xxx——」，那个破折号也别留在用户眼前。"""
        assert _clean_user_text("类似业绩证明材料缺失——clause_ids") == "类似业绩证明材料缺失"

    def test_normal_text_is_untouched(self):
        t = "报价明细表产地/品牌与技术响应表一致性未体现"
        assert _clean_user_text(t) == t

    def test_applied_by_the_model_validator(self):
        """光有函数不够——必须真的作用在提交上来的风险项上。"""
        from agent.agents.bidding_agent.schemas import RiskFinding

        f = RiskFinding(level="高风险", tone="destructive",
                        title="供应商情况一览表缺失——required_structure 构成项未提供",
                        advice="补建该章节", target_tab="business", target_id="b1",
                        anchor_text="", tender_ref="对应：构成要求（sec-8-c95）")
        assert "required_structure" not in f.title
        assert "sec-8-c95" not in f.tender_ref
