"""单章改写的上下文。

改写此前只拿到「原章 HTML + 用户指令」：不知道本章要响应哪些招标条款、提纲给本章写了什么
要求、隔壁章写的是什么。首次生成正文时这些信息都给足了，改写却全丢——改出来的内容可能脱离
招标要求，或者把相邻章的内容再写一遍。

这里钉住的是「该给的都给到了、且只给本章相关的」：全量读标结论有几万字，塞进来既贵又会淹没
用户当下的指令。
"""
from agent.agents.bidding_agent.nodes.content import _rewrite_context_block, _rewrite_msg

STATE = {
    "outline": {
        "chapters": [
            {"id": "t1", "no": "第一章", "title": "项目理解", "clause_ids": ["sec-1-c1"]},
            {
                "id": "t2", "no": "第二章", "title": "技术方案",
                "desc": "重点写对本院场景的理解，强调涉密合规",
                "clause_ids": ["sec-3-c1"],
                "items": [
                    {"label": "2.1 总体架构", "clause_ids": ["sec-3-c2"]},
                    {"label": "2.2 安全设计", "clause_ids": [],
                     "children": [{"label": "2.2.1 密码算法", "clause_ids": ["sec-4-c9"]}]},
                ],
            },
            {"id": "t3", "no": "第三章", "title": "实施计划", "clause_ids": []},
        ]
    },
    "read": {
        "categories": [
            {"name": "技术要求", "items": [
                {"title": "总体架构", "value": "三层架构", "star": False, "clause_ids": ["sec-3-c2"]},
                {"title": "硬件令牌", "value": "支持国密SM3", "star": True, "clause_ids": ["sec-4-c9"]},
                {"title": "无关要求", "value": "别章的", "star": False, "clause_ids": ["sec-9-c1"]},
            ]},
        ]
    },
}


class TestContext:
    def test_names_the_chapter(self):
        assert "第二章 技术方案" in _rewrite_context_block(STATE, "t2")

    def test_carries_the_user_written_brief(self):
        """写作说明是用户自己填的本章要求，首次生成会用，改写时也必须遵守。"""
        assert "涉密合规" in _rewrite_context_block(STATE, "t2")

    def test_lists_the_sections_of_this_chapter(self):
        out = _rewrite_context_block(STATE, "t2")
        assert "2.1 总体架构" in out and "2.2 安全设计" in out

    def test_neighbours_are_named_so_content_is_not_duplicated(self):
        out = _rewrite_context_block(STATE, "t2")
        assert "项目理解" in out and "实施计划" in out

    def test_pulls_the_tender_requirements_behind_this_chapter(self):
        """本章与其子项、孙项的 clause_ids 都要用上——只看章级会漏掉小节的依据。"""
        out = _rewrite_context_block(STATE, "t2")
        assert "硬件令牌" in out and "总体架构" in out

    def test_star_clauses_are_marked_and_come_first(self):
        """★ 排在前面：条目会被截断到前 12 条，不可偏离项不能因为排在后面被切掉。
        只看「招标要求」那一段——「总体架构」在小节列表里也出现过，全文搜下标会搜错地方。"""
        out = _rewrite_context_block(STATE, "t2")
        reqs = out.split("本章须响应的招标要求", 1)[1]
        assert "★ 硬件令牌" in reqs
        assert reqs.index("硬件令牌") < reqs.index("总体架构")

    def test_other_chapters_requirements_are_left_out(self):
        """给全量结论既贵又会淹没用户指令。"""
        assert "无关要求" not in _rewrite_context_block(STATE, "t2")

    def test_unknown_chapter_yields_nothing(self):
        assert _rewrite_context_block(STATE, "nope") == ""

    def test_bounded(self):
        big = {"outline": {"chapters": [{"id": "t1", "title": "x", "desc": "字" * 9000}]}, "read": {}}
        assert len(_rewrite_context_block(big, "t1")) <= 2000


class TestMessage:
    def test_instruction_comes_last(self):
        """指令压轴：它是用户当下最想要的，夹在中间容易被长上下文淹没。"""
        msg = _rewrite_msg("<p>旧</p>", "改成15分钟", "参考资料", "【本章定位】第二章")
        assert msg.rstrip().endswith("改成15分钟")
        assert msg.index("【本章定位】") < msg.index("原章 HTML")

    def test_still_works_without_any_context(self):
        """老项目没有提纲/读标结论时不能炸，退回原来的形状。"""
        msg = _rewrite_msg("<p>旧</p>", "改短些", "", "")
        assert "原章 HTML" in msg and msg.rstrip().endswith("改短些")
