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
from langchain_core.messages import AIMessage, AIMessageChunk

from agent.config import settings
from agent.framework.model_stream import ModelIdleTimeout
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


def test_self_fallback_matches_the_primary_exactly(monkeypatch):
    """第二跳是自己时，构造参数必须与主模型完全一致。

    get_chat(provider=None) 的「沿用链首」分支**不抄 thinking**，主模型用的是全局默认（关）；
    若照链里那项把 thinking=True 带上，重试这一跳就成了另一个模型——延迟与成本都不同，
    而本仓记录过「思考 + 流式强制 tool_choice = 400」，等于把可恢复的瞬断变成必挂的 400。
    """
    from agent.models.gateway import ModelGateway
    from agent.config import settings

    monkeypatch.setattr(settings, "model_chain", [
        {"provider": "deepseek", "model": "m1", "base_url": None, "api_key": "k1", "thinking": True},
    ], raising=False)
    out = resilient_chat(ModelGateway(settings), provider=None)
    assert isinstance(out, ResilientChat) and out.fallback_is_self
    # extra_body 是 ChatOpenAI 的顶层属性，不在 model_kwargs 里——第一版取错了地方，
    # 两边都读出 None、断言恒真，变异测试才把这条空守卫揪出来。
    prim_extra = getattr(out, "extra_body", None)
    fb_extra = getattr(out.fallback, "extra_body", None)
    assert prim_extra == fb_extra, f"自我重试与主模型参数不一致：{prim_extra} vs {fb_extra}"


def test_self_retry_waits_but_cross_model_does_not():
    """重打同一端点前要等一下（openai SDK 已经连打过 3 次）；换别的端点不必等。"""
    import agent.models.resilient as mod

    slept = []

    async def _fake_sleep(s):
        slept.append(s)

    orig = mod.asyncio.sleep
    mod.asyncio.sleep = _fake_sleep
    try:
        c = _patched(fallback=_Fallback(), raise_exc=_APIConnectionError("Connection error."))
        object.__setattr__(c, "fallback_is_self", True)
        asyncio.run(c._wait_before_self_retry())
        assert slept == [mod._SELF_RETRY_DELAY_S], "重打自己之前没有等待"
        slept.clear()
        object.__setattr__(c, "fallback_is_self", False)
        asyncio.run(c._wait_before_self_retry())
        assert slept == [], "换模型不该白等"
    finally:
        mod.asyncio.sleep = orig


def test_chain_raising_does_not_kill_content():
    """gateway.chain() 抛错时退回普通模型。在「建模型」这步崩比瞬断更糟——整步直接没了。"""

    class _Boom:
        def chain(self):
            raise RuntimeError("配置读取炸了")

        def get_chat(self, **kw):
            return "普通模型"

    assert resilient_chat(_Boom(), provider=None) == "普通模型"


# ---------------- 超时三层（2026-08-08 生产事故）----------------
# 正文写到第 20/20 章挂死 **26 分钟、一个字都没吐**：那时这条路只有降级链，没有任何超时，
# 挂死了就一直挂着——用户干等，积分冻着，而其它步骤 20 分钟就会判超时并降级重试。
# 本仓铁律：流式 + 空闲超时 + 单轮总时长盖 + 降级链，**三层缺一不可**。

async def _never_yields():
    """连上了但一个 token 都不吐——生产里挂死的样子。"""
    await asyncio.sleep(3600)
    yield  # pragma: no cover


async def _trickle():
    """慢而不死：每次都在空闲阈值之内吐一个，靠空闲检测永远抓不住。"""
    while True:
        await asyncio.sleep(0.01)
        yield AIMessageChunk(content="慢")


def _timed_chat() -> ResilientChat:
    return ResilientChat(model="m", api_key="k", base_url="http://x/v1", fallback=None)


def test_hung_stream_raises_instead_of_hanging_forever(monkeypatch):
    """首 token 迟迟不来 → 判挂死，而不是无限等。"""
    monkeypatch.setattr(settings, "model_first_token_timeout_s", 0.05)
    monkeypatch.setattr(settings, "model_idle_timeout_s", 0.05)
    monkeypatch.setattr(settings, "model_round_timeout_s", 60)

    async def go():
        async for _ in _timed_chat()._timed(_never_yields()):
            pass

    with pytest.raises(ModelIdleTimeout):
        asyncio.run(asyncio.wait_for(go(), timeout=5))


def test_round_cap_catches_slow_but_not_dead(monkeypatch):
    """限流下每隔一点吐一个 token，能骗过空闲检测——总时长盖才杀得掉。"""
    monkeypatch.setattr(settings, "model_first_token_timeout_s", 5)
    monkeypatch.setattr(settings, "model_idle_timeout_s", 5)      # 空闲检测抓不住
    monkeypatch.setattr(settings, "model_round_timeout_s", 0.2)   # 靠总时长盖

    async def go():
        async for _ in _timed_chat()._timed(_trickle()):
            pass

    with pytest.raises(ModelIdleTimeout):
        asyncio.run(asyncio.wait_for(go(), timeout=5))


def test_timeout_is_treated_as_retryable(monkeypatch):
    """超时必须被认作**可降级**错误——否则加了超时也只是把"挂死"换成"直接失败"。"""
    assert _timed_chat()._should_fallback(ModelIdleTimeout()) is False   # 无降级模型时不重试
    c = ResilientChat(model="m", api_key="k", base_url="http://x/v1", fallback=_Fallback())
    assert c._should_fallback(ModelIdleTimeout()) is True


def test_healthy_stream_passes_through(monkeypatch):
    """正常吐字的流一个 chunk 都不能少——超时不该误杀健康的慢生成。"""
    monkeypatch.setattr(settings, "model_first_token_timeout_s", 5)
    monkeypatch.setattr(settings, "model_idle_timeout_s", 5)
    monkeypatch.setattr(settings, "model_round_timeout_s", 60)

    async def three():
        for t in ("一", "二", "三"):
            yield AIMessageChunk(content=t)

    async def go():
        return [c.content async for c in _timed_chat()._timed(three())]

    assert asyncio.run(go()) == ["一", "二", "三"]


class _HungPrimary(ResilientChat):
    """主模型连上了却一个 token 都不吐（生产里挂死的样子）。"""

    async def _primary_stream(self, messages, stop=None, run_manager=None, **kwargs):
        await asyncio.sleep(3600)
        yield  # pragma: no cover

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        """复刻真实 _astream 的结构，只把 super()._astream 换成挂死的桩。"""
        it = self._timed(self._primary_stream(messages, stop=stop, run_manager=run_manager, **kwargs))
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            return
        except Exception as e:  # noqa: BLE001
            if not self._should_fallback(e):
                raise
            async for c in self._timed(
                    self.fallback._astream(messages, stop=stop, run_manager=run_manager, **kwargs)):
                yield c
            return
        yield first
        async for c in it:
            yield c


def test_hung_primary_switches_to_the_fallback(monkeypatch):
    """**挂死必须换模型，而不是一直等，也不是直接失败**。

    这是 2026-08-08 那次事故的完整链路：主模型不吐 token → 超时判挂死 →
    该超时被认作可降级 → 换降级模型接着写。三个环节缺一，用户就是干等 26 分钟。
    """
    monkeypatch.setattr(settings, "model_first_token_timeout_s", 0.05)
    monkeypatch.setattr(settings, "model_idle_timeout_s", 0.05)
    monkeypatch.setattr(settings, "model_round_timeout_s", 60)

    fb = _Fallback()

    async def fb_stream(messages, stop=None, run_manager=None, **kw):
        fb.calls += 1
        yield AIMessageChunk(content="降级模型接手")

    object.__setattr__(fb, "_astream", fb_stream)
    c = _HungPrimary(model="m", api_key="k", base_url="http://x/v1", fallback=fb)

    async def go():
        return [x.content async for x in c._astream([HumanMessage(content="写")])]

    assert asyncio.run(asyncio.wait_for(go(), timeout=5)) == ["降级模型接手"]
    assert fb.calls == 1


def test_the_real_astream_wraps_the_stream_in_the_timeout():
    """守住"写了限时包装却没在 _astream 里用它"这一种失败法——
    只测 _timed() 本身的话，那种改法测试照样全绿，而线上依旧挂死。"""
    import inspect

    src = inspect.getsource(ResilientChat._astream)
    assert "self._timed(" in src, "_astream 没有套上限时包装"
    assert src.count("self._timed(") >= 2, "降级那一支也必须套（否则换了模型照样能挂死）"


# ---------------- 非流式路径（正文实际走的那条）----------------
# langgraph 的执行器调 model.ainvoke，而 ainvoke 只有挂了流式回调才转流式——正文挂的三个回调
# 都不是。所以正文走 _agenerate，"30 秒不吐字"那种空闲判据在这里根本不适用，只能整通调用限时。
# 2026-08-08：先给 _astream 加了超时，而生产路径压根不经过它——写了但没接上。

def test_hung_non_streaming_call_is_capped(monkeypatch):
    """非流式调用挂死 → 判超时 → 换降级模型，而不是无限等。"""
    monkeypatch.setattr(settings, "model_round_timeout_s", 0.1)
    fb = _Fallback()
    c = _Patched(model="m", api_key="k", base_url="http://x/v1", fallback=fb)

    async def hang(messages, stop=None, run_manager=None, **kw):
        await asyncio.sleep(3600)

    object.__setattr__(c, "_primary_agenerate",
                       lambda *a, **k: c._capped(hang(*a, **k)))

    out = asyncio.run(asyncio.wait_for(
        c._agenerate([HumanMessage(content="写")]), timeout=5))
    assert out.generations[0].message.content == "降级模型的回答"
    assert fb.calls == 1


def test_the_real_agenerate_applies_the_cap():
    """守住"限时只加在流式路径上"这一种失败法——正文根本不走流式，
    那样改测试全绿而线上照挂（2026-08-08 就是这么发生的）。降级那一支也必须限时。"""
    import inspect

    src = inspect.getsource(ResilientChat._agenerate)
    assert src.count("self._capped(") >= 2, "_agenerate 或它的降级分支没有限时"


def test_healthy_non_streaming_call_is_untouched(monkeypatch):
    """正常返回的调用不受影响——上限是兜底，不该误杀慢而健康的生成。"""
    monkeypatch.setattr(settings, "model_round_timeout_s", 60)
    c = _patched()
    out = asyncio.run(c._agenerate([HumanMessage(content="写")]))
    assert out.generations[0].message.content == "主模型的回答"
