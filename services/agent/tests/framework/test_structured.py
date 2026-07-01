import asyncio
from pydantic import BaseModel
from agent.framework.structured import make_submit_tool


class ReadResult(BaseModel):
    categories: list[str]
    risks: list[str]


def test_submit_tool_validates_and_captures():
    tool, get_last = make_submit_tool("submit_read", ReadResult, "提交读标结果")
    out = asyncio.run(tool.ainvoke({"categories": ["技术标"], "risks": ["资质缺失"]}))
    assert "submit_read" in out
    last = get_last()
    assert isinstance(last, ReadResult) and last.categories == ["技术标"]


def test_submit_tool_rejects_invalid():
    tool, _ = make_submit_tool("submit_read", ReadResult, "x")
    import pytest
    with pytest.raises(Exception):
        asyncio.run(tool.ainvoke({"categories": "not-a-list"}))
