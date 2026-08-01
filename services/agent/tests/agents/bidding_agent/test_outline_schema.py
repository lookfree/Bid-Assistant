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


def test_chapter_items_is_required_and_described_in_the_tool_schema():
    """2026-08-01 生产事故：主模型换成客户本地的 Qwen3.6-35B-A3B-W4A8 后，整份提纲只剩章节标题。
    模型把没标 required、没写 description 的 items **整个字段省略**，pydantic 默认值补成 []
    后校验照样通过（事件日志 outcome: ok，全程无报错）——同期的 deepseek 会照系统提示词补全，
    于是缺陷被掩盖到换模型才暴露。承载内容的字段必须 required + 有说明，弱模型只认工具 schema。"""
    from langchain_core.utils.function_calling import convert_to_openai_tool

    tool, _ = make_submit_tool("submit_outline", Outline, "提交提纲")
    chapter = convert_to_openai_tool(tool)["function"]["parameters"]["properties"]["chapters"]["items"]
    assert "items" in chapter.get("required", []), "章的 items 不是必填，模型可以整个省掉 → 提纲只剩标题"
    assert "必填" in (chapter["properties"]["items"].get("description") or ""), "items 没有字段说明"

    # 下探层级同样要有说明，否则弱模型只会产两级（章→节）、再也不往下拆
    node = chapter["properties"]["items"]["items"]
    for level in ("三级", "四级", "五级"):
        children = node["properties"]["children"]
        assert level in (children.get("description") or ""), f"{level} children 没有字段说明"
        node = children["items"]
        if "children" not in node.get("properties", {}):
            break


def test_chapter_without_items_is_rejected():
    """兜底断言：省略 items 的提交必须报错，而不是被默认值补成空数组静默通过。"""
    import pytest
    from pydantic import ValidationError

    bad = {"chapters": [{"id": "t1", "no": "第一章", "title": "技术标书", "group": "tech", "sourced": True}]}
    with pytest.raises(ValidationError):
        Outline(**bad)
