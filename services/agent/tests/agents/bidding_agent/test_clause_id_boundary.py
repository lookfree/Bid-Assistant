"""内部条款 id 的边界规则（系统性守卫，不是逐处补丁）。

规则一句话：**内部 id 只在提纲这一步进出模型，其余每一步喂之前剥掉。**

它是什么：sec-19-c129 这类是**我们代码内部的连接键**——_template_block 靠它把招标原文的
格式模板捞出来，_chapter_requirements 靠它取本章要响应的条款，前端靠它让用户点回原文定位。
这些用途都在代码里，不需要模型看见。

为什么必须在**输入**这一侧管：2026-08-08 用户截图，偏离表整整一列印着 sec-19-c129…，
而那一列正是提示词点名要的（"招标要求条款（章节号/clause_ids）"）——模型是照做的。
逐处清洗输出永远慢一步：清完审查清正文，清完正文清述标，漏一处就印进交付给评委的标书。
模型看不见，才不会写出来。
"""
import json
import re

import pytest

from agent.agents.bidding_agent.nodes.common import slim_read, strip_clause_ids

_ID = re.compile(r"sec-\d+-c\d+")

_READ = {"project_meta": {}, "categories": [{"key": "technical", "title": "技术", "items": [
    {"title": "最高限价", "value": "96万元", "star": True, "clause_ids": ["sec-19-c129", "sec-19-c130"]}]}],
    "scoring": [{"id": "s1", "name": "方案", "clause_ids": ["sec-2-c8"]}],
    "risk_summary": [], "required_structure": [{"name": "投标函", "clause_ids": ["sec-8-c1"]}]}
_OUTLINE = {"chapters": [{"id": "b2", "no": "第二章", "title": "报价一览表", "group": "business",
                          "sourced": True, "items": [{"id": "i1", "label": "报价表",
                                                      "clause_ids": ["sec-51-c1"]}]}]}


class TestStripper:
    @pytest.mark.parametrize("src", [_READ, _OUTLINE, slim_read(_READ)])
    def test_no_internal_id_survives(self, src):
        assert not _ID.search(json.dumps(strip_clause_ids(src), ensure_ascii=False))

    def test_everything_else_is_untouched(self):
        """剥的是键，不是内容——要求文本、★标记、评分项都得原样留着，
        模型正是靠这些写偏离表的。"""
        out = strip_clause_ids(_READ)
        it = out["categories"][0]["items"][0]
        assert it["title"] == "最高限价" and it["value"] == "96万元" and it["star"] is True
        assert out["scoring"][0]["name"] == "方案"
        assert out["required_structure"][0]["name"] == "投标函"

    def test_the_original_is_not_mutated(self):
        """代码内部还要拿原对象做定位（_template_block/_chapter_requirements），不能被就地改掉。"""
        strip_clause_ids(_READ)
        assert _READ["categories"][0]["items"][0]["clause_ids"] == ["sec-19-c129", "sec-19-c130"]


class TestBoundary:
    """逐步核对：谁的模型输入里还能看到内部 id。"""

    def test_content_message_has_none(self, monkeypatch):
        import asyncio

        from agent.agents.bidding_agent.nodes import content as content_mod
        from .test_content_node import _FakeDeep, _ctx

        captured = {}

        class _Capturing(_FakeDeep):
            async def ainvoke(self, _input, config=None):
                captured["user"] = _input["messages"][0].content
                return await super().ainvoke(_input, config)

        monkeypatch.setattr(content_mod, "create_deep_agent",
                            lambda **kw: _Capturing({"/chapters/b2.html": {"content": "<p>x</p>"}}))
        asyncio.run(content_mod.make_content_node(_ctx())({"outline": _OUTLINE, "read": _READ}))
        assert not _ID.search(captured["user"]), \
            f"正文的模型输入里还有内部 id：{_ID.findall(captured['user'])[:5]}"
        assert "报价一览表" in captured["user"]      # 该给的内容一个没少

    def test_outline_step_still_gets_them(self):
        """提纲是**唯一**要保留的一步：条目要产出 clause_ids，前端靠它点回原文定位。
        把它也剥了，定位功能就没了——这条规则不是"到处都删"。"""
        assert _ID.search(json.dumps(slim_read(_READ), ensure_ascii=False))


class TestDeviationTable:
    """偏离表是**印进交付文档**的那张表，用户截图里整整一列都是 sec-19-c129…。
    它有两个源头，缺一不可地堵：喂进去的条目数据，和提示词里点名要的那一列。"""

    def test_prompt_never_asks_for_internal_ids(self):
        from agent.agents.bidding_agent.prompts.content import DEVIATION_TABLE_GUIDE

        # 连"禁止写 sec-xx"这种说法都不留：给模型看一个被禁格式的样例，本身就是在示范它。
        assert "clause_ids" not in DEVIATION_TABLE_GUIDE, \
            "偏离表列式里还点名要 clause_ids——模型会照做，这不是模型的错"
        assert not _ID.search(DEVIATION_TABLE_GUIDE), "提示词里出现了内部 id 的样例"
        assert "招标要求出处" in DEVIATION_TABLE_GUIDE      # 改成招标文件自己的编号

    def test_the_source_column_has_real_data_behind_it(self):
        """「招标要求出处」这一列必须有东西可填：给内部 id 指向的**章节标题**。
        只是把 id 拿掉、留一个空列，模型会去编条款号——编造的引用印在交给评委的偏离表里
        比空格子更糟。"""
        from agent.agents.bidding_agent.nodes.content import _deviation_items_block

        read = {**_READ, "doc_headings": [{"sec": "sec-19", "title": "第五章 技术规范书", "level": 1}]}
        block = _deviation_items_block(read)
        assert "第五章 技术规范书" in block, "出处列没有可填的数据，模型只能留空或编造"
        assert not _ID.search(block)

    def test_source_is_omitted_when_unknown(self):
        """对不上章节标题时**不给这个字段**——宁可留空，也不要给模型一个半截线索去编。"""
        from agent.agents.bidding_agent.nodes.content import _deviation_items_block

        assert '"source"' not in _deviation_items_block(_READ)

    def test_items_fed_to_the_table_carry_no_ids(self):
        from agent.agents.bidding_agent.nodes.content import _deviation_items_block

        block = _deviation_items_block(_READ)
        assert not _ID.search(block), f"偏离表条目里还带内部 id：{_ID.findall(block)[:5]}"
        assert "最高限价" in block and "96万元" in block    # 该给的要求内容一个没少
