"""正文用的带降级模型。

2026-08-07 生产数据：近 10 天 content 成功 3 次、失败 25 次，其中 **18 次是
`APIConnectionError: Connection error.`**；而连接类错误在 read/outline/review/present
一次都没有——它们走 framework/create_agent，瞬断会自动换降级模型再试。
正文是全流程唯一不走那条路的节点（模型直接交给 deepagents），于是一次瞬断就打掉整步；
而它恰恰跑十几到二十几分钟、按产出字数计费。

这里钉住的就是"瞬断要换模型、语义错误不要换"，以及 bind_tools 必须还能用——
deepagents 内部要绑工具，这也是不能用 Runnable.with_fallbacks 的原因。
"""
import asyncio

import pytest
from langchain_core.messages import HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.messages import AIMessage

from agent.models.resilient import ResilientChat, resilient_chat


def _result(text: str) -> ChatResult:
    return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])


class _Fallback:
    """降级模型桩：只需实现 _agenerate/_astream。"""

    def __init__(self):
        self.calls = 0

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        self.calls += 1
        return _result("降级模型的回答")


class _Patched(ResilientChat):
    """把 super()._agenerate 换成可控桩，验证降级分支。"""

    async def _agenerate(self, messages, stop=None, run_manager=None, **kw):
        try:
            return await self._primary_agenerate(messages, stop=stop, run_manager=run_manager, **kw)
        except Exception as e:  # noqa: BLE001
            if not self._should_fallback(e):
                raise
            return await self.fallback._agenerate(messages, stop=stop, run_manager=run_manager, **kw)


def _patched(fallback=None, raise_exc=None) -> _Patched:
    c = _Patched(model="m", api_key="k", base_url="http://x/v1", fallback=fallback)

    async def _boom(messages, stop=None, run_manager=None, **kw):
        if raise_exc is not None:
            raise raise_exc
        return _result("主模型的回答")

    object.__setattr__(c, "_primary_agenerate", _boom)
    return c


class _APIConnectionError(Exception):
    """名字里带 apiconnectionerror —— 与 openai SDK 那个同形，判定按类型名匹配。"""


def test_transient_error_switches_to_fallback():
    """瞬断必须换模型：这正是 18 次失败的形态。"""
    fb = _Fallback()
    c = _patched(fallback=fb, raise_exc=_APIConnectionError("Connection error."))
    out = asyncio.run(c._agenerate([HumanMessage(content="写第一章")]))
    assert out.generations[0].message.content == "降级模型的回答"
    assert fb.calls == 1


def test_auth_error_switches_too():
    """401 对这家是确定性错误，重试同一家没意义——换下一家正是降级链的意义。"""
    fb = _Fallback()
    c = _patched(fallback=fb, raise_exc=Exception("Error code: 401 - invalid api key"))
    asyncio.run(c._agenerate([HumanMessage(content="x")]))
    assert fb.calls == 1


def test_semantic_error_is_not_retried():
    """400 参数错误换个模型照样错，白花一次钱还拖长时间。"""
    fb = _Fallback()
    c = _patched(fallback=fb, raise_exc=ValueError("Error code: 400 - invalid schema"))
    with pytest.raises(ValueError):
        asyncio.run(c._agenerate([HumanMessage(content="x")]))
    assert fb.calls == 0


def test_no_fallback_configured_raises_through():
    c = _patched(fallback=None, raise_exc=_APIConnectionError("Connection error."))
    with pytest.raises(_APIConnectionError):
        asyncio.run(c._agenerate([HumanMessage(content="x")]))


def test_success_does_not_touch_fallback():
    fb = _Fallback()
    c = _patched(fallback=fb)
    out = asyncio.run(c._agenerate([HumanMessage(content="x")]))
    assert out.generations[0].message.content == "主模型的回答" and fb.calls == 0


def test_bind_tools_still_available():
    """deepagents 内部要 bind_tools——这正是不能用 Runnable.with_fallbacks 的原因
    （它返回的 RunnableWithFallbacks 没有这个方法）。"""
    c = ResilientChat(model="m", api_key="k", base_url="http://x/v1")
    assert hasattr(c, "bind_tools")


class _GatewayOne:
    def chain(self):
        return [{"provider": "p", "model": "m"}]

    def get_chat(self, **kw):
        return ResilientChat(model=kw.get("model") or "m", api_key="k", base_url="http://x/v1")


class _GatewayTwo:
    def __init__(self):
        self.calls = []

    def chain(self):
        return [{"provider": "p1", "model": "m1"}, {"provider": "p2", "model": "m2"}]

    def get_chat(self, **kw):
        self.calls.append(kw)
        return ResilientChat(model=kw.get("model") or "m", api_key="k", base_url="http://x/v1")


def test_single_model_chain_still_retries_the_primary():
    """没配降级模型时，第二跳打主模型自己——与 forced_stream_submit 同一口径。

    瞬断是一瞬的事，同一端点隔一下再打通常就成了。此时放弃重试等于把"没配降级"
    变成"没有任何保护"，而正文恰恰是最长最贵的一步。
    """
    g = _GatewayOne()
    out = resilient_chat(g, provider=None)
    assert isinstance(out, ResilientChat)
    assert out.fallback is not None and out.fallback_is_self is True


def test_no_chain_at_all_returns_plain_model():
    """连链都取不到（异常/桩装配）：保持原样，不臆造降级。"""

    class _NoChain:
        def get_chat(self, **kw):
            return "普通模型"

    assert resilient_chat(_NoChain(), provider=None) == "普通模型"


def test_auth_error_is_not_retried_against_the_same_key():
    """第二跳就是自己时，401 不重试：同一把 key 再打一万次还是 401，只会拖成两倍时长。"""
    fb = _Fallback()
    c = _patched(fallback=fb, raise_exc=Exception("Error code: 401 - invalid api key"))
    object.__setattr__(c, "fallback_is_self", True)
    with pytest.raises(Exception, match="401"):
        asyncio.run(c._agenerate([HumanMessage(content="x")]))
    assert fb.calls == 0


def test_transient_error_is_retried_even_against_the_same_endpoint():
    fb = _Fallback()
    c = _patched(fallback=fb, raise_exc=_APIConnectionError("Connection error."))
    object.__setattr__(c, "fallback_is_self", True)
    asyncio.run(c._agenerate([HumanMessage(content="x")]))
    assert fb.calls == 1


def test_two_model_chain_wires_the_second_as_fallback():
    g = _GatewayTwo()
    out = resilient_chat(g, provider=None)
    assert isinstance(out, ResilientChat) and out.fallback is not None
    assert any(c.get("model") == "m2" for c in g.calls), "降级模型没有按链里的第二项构造"


def test_real_gateway_call_signature(monkeypatch):
    """按正文节点的真实调用方式跑一遍：resilient_chat(gateway, provider=None)。

    第一版把 provider 既放进 **kw 又显式传了一次，真实调用必 TypeError——
    正文节点会在建模型这一步当场崩，比瞬断更糟。桩测试没覆盖到，是这条把它抓出来的。
    """
    from agent.models.gateway import ModelGateway
    from agent.config import settings

    monkeypatch.setattr(settings, "model_chain", [
        {"provider": "custom", "model": "主", "base_url": "http://a/v1", "api_key": "k1"},
        {"provider": "custom", "model": "降级", "base_url": "http://b/v1", "api_key": "k2"},
    ], raising=False)
    out = resilient_chat(ModelGateway(settings), provider=None)
    assert isinstance(out, ResilientChat), "真实网关下没有装配出带降级的模型"
    assert out.fallback is not None
    assert hasattr(out, "bind_tools")
