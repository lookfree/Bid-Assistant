import asyncio
from langchain_core.messages import HumanMessage, AIMessage
from agent.framework.compressor import make_compressor_node


class _FakeGateway:
    def invoke(self, messages, **kw):
        return AIMessage(content="摘要：前文略")


def test_compressor_keeps_recent_and_summarizes_when_over():
    node = make_compressor_node(_FakeGateway(), max_tokens=20, keep_recent=2)
    msgs = [HumanMessage(content="x" * 50), AIMessage(content="a"), HumanMessage(content="b"), AIMessage(content="c")]
    out = asyncio.run(node({"messages": msgs}))
    new = out["messages"]
    # 压缩：保留最近 2 条 + 1 条摘要在前
    assert new[-2].content == "b" and new[-1].content == "c"
    assert "摘要" in new[0].content


def test_compressor_noop_when_under():
    node = make_compressor_node(_FakeGateway(), max_tokens=10_000, keep_recent=2)
    msgs = [HumanMessage(content="hi")]
    out = asyncio.run(node({"messages": msgs}))
    assert out == {} or out.get("messages") in (None, msgs)  # 未超阈值不改
