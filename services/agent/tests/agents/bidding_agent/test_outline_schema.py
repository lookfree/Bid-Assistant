import asyncio
from agent.agents.bidding_agent.schemas import Outline
from agent.framework.structured import make_submit_tool


_SAMPLE = {"chapters": [
    {"id": "t1", "no": "第一章", "title": "项目理解与整体方案", "group": "tech", "sourced": True,
     "items": [{"id": "t1-1", "label": "1.1 项目背景与需求理解", "clause_ids": ["sec-technical-c1"]},
               {"id": "t1-3", "label": "1.3 方案亮点与服务承诺", "is_new": True}]},
    {"id": "b3", "no": "第三章", "title": "商务报价与价格构成", "group": "business", "sourced": True,
     "items": [{"id": "b3-1", "label": "3.1 投标报价一览表"}]},
]}


def test_outline_groups():
    o = Outline(**_SAMPLE)
    assert [c.id for c in o.tech] == ["t1"] and [c.id for c in o.business] == ["b3"]
    assert o.tech[0].items[1].is_new is True


def test_outline_chapter_structure_ref_defaults_none_and_accepted():
    """旧提纲无 structure_ref → 默认 None（向后兼容）；新提纲可显式设置对齐 required_structure（spec321）。"""
    o = Outline(**_SAMPLE)
    assert o.chapters[0].structure_ref is None
    sample = {"chapters": [{**_SAMPLE["chapters"][1], "structure_ref": "s1"}]}
    o2 = Outline(**sample)
    assert o2.chapters[0].structure_ref == "s1"


def test_submit_outline_captures():
    tool, get = make_submit_tool("submit_outline", Outline, "提交提纲")
    asyncio.run(tool.ainvoke(_SAMPLE))
    assert get().model_dump() == Outline(**_SAMPLE).model_dump()   # 捕获即原样往返
