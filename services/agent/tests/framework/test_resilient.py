import asyncio
from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from agent.framework.resilient import resilient_tool_node


async def _boom(x: str) -> str:
    raise RuntimeError("kaboom")


def test_tool_error_becomes_tool_message():
    tool = StructuredTool.from_function(coroutine=_boom, name="boom", description="x")
    node = resilient_tool_node([tool])
    ai = AIMessage(content="", tool_calls=[{"name": "boom", "args": {"x": "1"}, "id": "c1"}])
    out = asyncio.run(node({"messages": [ai]}))
    msgs = out["messages"]
    assert msgs[0].status == "error" and "kaboom" in msgs[0].content   # 不抛、转 ToolMessage 错误
