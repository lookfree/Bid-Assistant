"""常用文本·企业信息 → 表单章填空用的投标人信息。"""

from agent.agents.bidding_agent.nodes.bidder_profile import bidder_fields, profile_block

STRUCTURED = {
    "title": "企业信息",
    "fields": [{"label": "单位名称", "value": "上海安几科技有限公司"},
               {"label": "统一社会信用代码", "value": "91310115MA1K35XY7B"},
               {"label": "法定代表人", "value": "冯世瑾"}],
}
FREE_TEXT = {
    "title": "公司基本信息",
    "body": "单位名称：上海安几科技有限公司\n开户银行：招商银行上海张江支行\n账号：121900000123456\n"
            "这一行不是字段，只是备注",
}


class TestBidderFields:
    def test_structured_fields_come_through_as_entered(self):
        """用户录什么标签就发什么。系统去猜「单位名称/公司名称/投标人名称」哪个算数，
        只会在猜错时悄悄填错值。"""
        assert bidder_fields([STRUCTURED])[:2] == [
            ("单位名称", "上海安几科技有限公司"), ("统一社会信用代码", "91310115MA1K35XY7B")]

    def test_free_text_lines_are_parsed_too(self):
        """多数人是直接在正文里按「标签：值」写的，不会去用结构化字段。"""
        got = dict(bidder_fields([FREE_TEXT]))
        assert got["开户银行"] == "招商银行上海张江支行"
        assert got["账号"] == "121900000123456"

    def test_a_line_without_a_label_is_not_a_field(self):
        assert "这一行不是字段" not in dict(bidder_fields([FREE_TEXT]))

    def test_first_entry_wins_on_duplicate_labels(self):
        """两条企业信息都写了单位名称时取先出现的那条，不把两个值一起发给模型让它挑。"""
        other = {"title": "企业信息（旧）", "fields": [{"label": "单位名称", "value": "旧公司名"}]}
        assert dict(bidder_fields([STRUCTURED, other]))["单位名称"] == "上海安几科技有限公司"

    def test_a_huge_entry_cannot_flood_the_brief(self):
        """常用文本里还放着技术方案片段：整段灌进表单章简报会把单章预算顶穿。"""
        big = {"title": "企业信息", "body": "\n".join(f"字段{i}：值{i}" for i in range(200))}
        assert len(bidder_fields([big])) <= 30

    def test_a_long_value_is_truncated_not_dropped(self):
        """一条长注册地址不该整行匹配失败被静默丢掉——结构化 fields 那条路是截断的，
        同一份数据两条路必须给出同样的结果。"""
        addr = ("上海市浦东新区张江高科技园区科苑路399号张江创新园区7号楼3层301室"
                "（中国（上海）自由贸易试验区内，园区西南门进入后左转第三栋）")
        got = dict(bidder_fields([{"title": "企业信息", "body": f"注册地址：{addr}"}]))
        assert "注册地址" in got, "长值让整行匹配失败，字段被静默丢掉"
        assert got["注册地址"] == addr[:60]

    def test_broken_input_never_raises(self):
        assert bidder_fields([]) == []
        assert bidder_fields([None, {"fields": [None]}, {"body": None}]) == []

    def test_a_non_dict_field_row_does_not_kill_the_whole_step(self):
        """_shared_blocks 在 gather 之前跑，没有 _chapter_brief 那种「只废本章」的隔离：
        一条脏数据抛异常 = 整个计费的正文步失败。"""
        got = bidder_fields([{"title": "企业信息",
                              "fields": ["单位名称：X", {"label": "法定代表人", "value": "冯世瑾"}]}])
        assert dict(got) == {"法定代表人": "冯世瑾"}


class TestProfileBlock:
    def test_block_tells_the_model_to_fill_but_not_rewrite(self):
        block = profile_block([STRUCTURED])
        assert "上海安几科技有限公司" in block
        assert "不得改写模板的固定文字" in block, "填空指令必须同时重申不许改原文"

    def test_no_entry_means_no_block(self):
        """没录企业信息的用户，简报要逐字节不变——不能凭空多出一个空段落。"""
        assert profile_block([]) == ""
