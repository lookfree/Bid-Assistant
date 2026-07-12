import asyncio
import uuid

import pytest
from langchain_core.messages import AIMessageChunk

from agent.framework import model_stream as ms
from agent.runtime.registry import RunContext


class _StreamChat:
    """astream 按 gaps 逐个吐 chunk：gap 大于空闲超时 = 模拟连接挂死；gap 小则健康（哪怕总时长很长）。"""

    def __init__(self, gaps: list[float], tool_name: str = "submit_x"):
        self.gaps = gaps
        self.tool_name = tool_name

    def bind_tools(self, tools, **kw):
        return self

    async def astream(self, messages, **kw):
        # 真实流式：工具名/ id 只在首个 chunk 出现，其余 chunk 靠 index 续 args（这里首块起 JSON）
        for i, gap in enumerate(self.gaps):
            await asyncio.sleep(gap)
            first = i == 0
            yield AIMessageChunk(content="", tool_call_chunks=[{
                "name": self.tool_name if first else None,
                "args": "{" if first else "",
                "id": "c1" if first else None, "index": 0}])
        # 收尾补全 args 成合法 JSON，聚合后 tool_calls 可解析
        yield AIMessageChunk(content="", tool_call_chunks=[{"args": '"x":1}', "index": 0}])


class _Gateway:
    """chain() 定义主/降级；get_chat 按调用序返回预置 chats（模拟主挂死→降级接手）。"""

    def __init__(self, chats: list, chain: list[dict]):
        self.chats = chats
        self.i = 0
        self._chain = chain

    def chain(self):
        return self._chain

    def get_chat(self, **kw):
        chat = self.chats[min(self.i, len(self.chats) - 1)]
        self.i += 1
        return chat


def _ctx(gateway=None):
    return RunContext(run_id=str(uuid.uuid4()), agent_type="t", thread_id=str(uuid.uuid4()), gateway=gateway)


@pytest.fixture
def _fast_timeout(monkeypatch):
    """把空闲/首token超时压到 0.3s，测试无需真等 30s。"""
    monkeypatch.setattr(ms.settings, "model_idle_timeout_s", 0.3)
    monkeypatch.setattr(ms.settings, "model_first_token_timeout_s", 0.3)


async def test_healthy_slow_stream_not_killed(_fast_timeout):
    """核心诉求：token 持续吐（每次 gap < 空闲超时），哪怕总时长(1s)远超单次超时(0.3s)也不判挂死。"""
    chat = _StreamChat(gaps=[0.1] * 10)   # 总 ~1s，但每步 0.1s < 0.3s
    msg = await ms.astream_collect(chat, [], _ctx(), label=None)
    assert msg.tool_calls and msg.tool_calls[0]["name"] == "submit_x"


async def test_idle_gap_triggers_timeout(_fast_timeout):
    """单次 gap 超过空闲超时(0.3s) → 判连接挂死 → 抛 ModelIdleTimeout。"""
    chat = _StreamChat(gaps=[1.0])
    with pytest.raises(ms.ModelIdleTimeout):
        await ms.astream_collect(chat, [], _ctx(), label=None)


async def test_primary_hang_downgrades_and_succeeds(_fast_timeout):
    """主模型挂死(gap>超时) → 换降级模型(健康)重试一次 → 成功；共取两次 chat。"""
    primary = _StreamChat(gaps=[1.0])            # 主：首 token 就超时
    downgrade = _StreamChat(gaps=[0.0])          # 降级：立即吐
    gw = _Gateway([primary, downgrade], chain=[{"model": "big"}, {"model": "small"}])

    async def _submit(**kw):
        ...
    msg = await ms.forced_stream_submit(_ctx(gw), [], _submit, "submit_x", label="读标·技术块")
    assert msg.tool_calls[0]["name"] == "submit_x"
    assert gw.i == 2   # 主 + 降级各取一次


async def test_both_hang_raises(_fast_timeout):
    """主与降级都挂死 → 抛 ModelIdleTimeout（本节点失败，run 可重试）。"""
    gw = _Gateway([_StreamChat(gaps=[1.0]), _StreamChat(gaps=[1.0])],
                  chain=[{"model": "big"}, {"model": "small"}])

    async def _submit(**kw):
        ...
    with pytest.raises(ms.ModelIdleTimeout):
        await ms.forced_stream_submit(_ctx(gw), [], _submit, "submit_x", label="读标·技术块")


class _EmptyChat:
    """astream 立即结束、零 chunk（软拒答/内容过滤）：连接健康，不该判成挂死。"""

    def bind_tools(self, tools, **kw):
        return self

    async def astream(self, messages, **kw):
        return
        yield   # noqa: 使函数成为异步生成器（永不到达）


async def test_empty_stream_returns_empty_not_timeout(_fast_timeout):
    """回归：正常结束但零 token → 回空消息（不抛 ModelIdleTimeout），让上层按"未提交"优雅放弃。"""
    msg = await ms.astream_collect(_EmptyChat(), [], _ctx(), label=None)
    assert not (msg.tool_calls or msg.content)   # 空消息：无工具调用、无内容


class _CountingChat:
    """记录 astream / ainvoke 调用次数：验证思考开关驱动的"流式 vs 非流式"路由。"""

    def __init__(self):
        self.astream_calls = 0
        self.ainvoke_calls = 0

    def bind_tools(self, tools, **kw):
        return self

    async def astream(self, messages, **kw):
        self.astream_calls += 1
        yield AIMessageChunk(content="", tool_call_chunks=[
            {"name": "submit_x", "args": '{"x":1}', "id": "c1", "index": 0}])

    async def ainvoke(self, messages):
        from langchain_core.messages import AIMessage
        self.ainvoke_calls += 1
        return AIMessage(content="", tool_calls=[{"name": "submit_x", "args": {"x": 1}, "id": "c1"}])


async def test_thinking_on_uses_ainvoke_not_stream(_fast_timeout):
    """思考开的模型：走非流式 ainvoke（思考模式 + 流式强制 tool_choice 不兼容），绝不调 astream。"""
    chat = _CountingChat()
    gw = _Gateway([chat, chat], chain=[{"model": "deepseek-v4-flash", "thinking": True}])

    async def _submit(**kw):
        ...
    msg = await ms.forced_stream_submit(_ctx(gw), [], _submit, "submit_x", label="审查")
    assert msg.tool_calls[0]["name"] == "submit_x"
    assert chat.astream_calls == 0 and chat.ainvoke_calls == 1


async def test_thinking_off_uses_stream(_fast_timeout):
    """思考关（默认）的模型：走流式（get_chat 下发关闭思考参），不走 ainvoke。"""
    chat = _CountingChat()
    gw = _Gateway([chat, chat], chain=[{"model": "deepseek-chat", "thinking": False}])

    async def _submit(**kw):
        ...
    msg = await ms.forced_stream_submit(_ctx(gw), [], _submit, "submit_x", label="审查")
    assert msg.tool_calls[0]["name"] == "submit_x"
    assert chat.astream_calls == 1 and chat.ainvoke_calls == 0
