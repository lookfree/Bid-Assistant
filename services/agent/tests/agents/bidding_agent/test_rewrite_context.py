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
            {"id": "t1", "no": "第一章", "title": "项目理解", "items": []},
            {
                # 注意：章本身**没有** clause_ids 字段（schemas.OutlineChapter），依据只挂在子项上。
                # 早先的样例把它放在章上，于是 ★ 断言靠一段生产走不到的死代码通过（复核指出）。
                "id": "t2", "no": "第二章", "title": "技术方案",
                "desc": "重点写对本院场景的理解，强调涉密合规",
                "items": [
                    {"label": "2.1 总体架构", "clause_ids": ["sec-3-c2"]},
                    {"label": "2.2 安全设计", "clause_ids": [], "children": [
                        {"label": "2.2.1 密码算法", "clause_ids": [], "children": [
                            {"label": "（1）算法选型", "clause_ids": [], "children": [
                                {"label": "① 国密支持", "clause_ids": ["sec-4-c9"]},   # 五级才有依据
                            ]},
                        ]},
                    ]},
                ],
            },
            {"id": "t3", "no": "第三章", "title": "实施计划", "items": []},
        ]
    },
    "read": {
        "categories": [
            {"key": "tech", "title": "技术要求", "items": [
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


class TestPackageScope:
    """多包件招标：同一条款会拆成「包1工期90天」「包2工期120天」两条，共用同一个 clause_id。

    不按所选包过滤，就会把**别的包**的要求当成本章的★不可偏离项写进标书——而提示词刚刚
    告诉模型★项必须逐条响应。用户投的是包2，标书里却承诺了包1的工期。
    """

    STATE = {
        "outline": {"chapters": [
            {"id": "t1", "no": "第一章", "title": "工期方案",
             "items": [{"label": "1.1 工期承诺", "clause_ids": ["sec-2-c7"]}]},
        ]},
        "read": {"categories": [{"key": "business", "title": "商务要求", "items": [
            {"title": "工期", "value": "包1 90 天", "star": True, "clause_ids": ["sec-2-c7"], "packages": ["p1"]},
            {"title": "工期", "value": "包2 120 天", "star": True, "clause_ids": ["sec-2-c7"], "packages": ["p2"]},
            {"title": "质保", "value": "全包通用 3 年", "star": False, "clause_ids": ["sec-2-c7"], "packages": []},
        ]}]},
        "run_input": {"package": {"id": "p2", "name": "包件二"}},
    }

    def test_only_the_selected_package_is_injected(self):
        out = _rewrite_context_block(self.STATE, "t1")
        assert "包2 120 天" in out
        assert "包1 90 天" not in out

    def test_package_agnostic_requirements_still_come_through(self):
        """packages 为空 = 全包通用，过滤掉它等于漏掉真正适用的要求。"""
        assert "全包通用 3 年" in _rewrite_context_block(self.STATE, "t1")


class TestStarSurvivesTheCap:
    """★ 条款不能被长度上限悄悄切掉。

    上下文按「定位/说明/小节/邻章 + 要求」拼，要求排最后。整串一刀切时先掉的正是 ★——
    而提示词向模型保证「★ 改写后必须仍然逐条响应」，切掉了就成了空头承诺。
    """

    def _state(self):
        long_desc = "写" * 2500   # 故意让「前面的部分 + 要求块」超过上限，逼出取舍
        return {
            "outline": {"chapters": [{
                "id": "t1", "no": "第一章", "title": "方案", "desc": long_desc,
                "items": [{"label": "1.1", "clause_ids": ["c1"]}],
            }]},
            "read": {"categories": [{"key": "tech", "title": "技术", "items": [
                {"title": "硬件令牌", "value": "支持国密SM3", "star": True, "clause_ids": ["c1"]},
            ]}]},
        }

    def test_star_requirement_is_kept(self):
        out = _rewrite_context_block(self._state(), "t1")
        assert "★ 硬件令牌" in out
        assert len(out) <= 2000

    def test_no_half_sentence(self):
        """按整行取舍：截到半句「- ★ 硬件令牌：支持国」比不给还糟。"""
        out = _rewrite_context_block(self._state(), "t1")
        assert out.rstrip().endswith("支持国密SM3")


class TestRefundGateComesFirst:
    """「这是不是一句提问」的判定必须排在最前面。

    它是**退款闸**：模型回 <!--NOT_AN_INSTRUCTION--> 时 App 判 422 并全额退款
    （apps/api/src/routes/projects.ts）。2026-08-07 给改写补上下文后，用户的问题被排到了
    一大段上下文之后——若判定规则又排在那些上下文规则之后，模型更容易把提问当成改写要求，
    结果是把「对问题的回答」当正文交稿、还照常计入产物。这条守卫盯的就是顺序。
    """

    def test_gate_is_stated_before_the_context_rules(self):
        from agent.agents.bidding_agent.prompts.content import REWRITE_PROMPT

        assert REWRITE_PROMPT.index("NOT_AN_INSTRUCTION") < REWRITE_PROMPT.index("【本章定位】")

    def test_gate_is_scoped_to_the_instruction_only(self):
        """明写「只看改写指令这一段」——否则长上下文会稀释这个判断。"""
        from agent.agents.bidding_agent.prompts.content import REWRITE_PROMPT

        assert "只看「改写指令」这一段" in REWRITE_PROMPT
