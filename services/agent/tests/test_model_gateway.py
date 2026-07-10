from types import SimpleNamespace
import pytest
from agent.config import Settings
from agent.models.gateway import ModelGateway


def _settings(**over):
    base = dict(database_url="postgresql://x:y@h:5432/d", deepseek_api_key="k1", dashscope_api_key="k2",
                model_default_provider="deepseek", model_fallbacks="qwen:qwen-plus")
    base.update(over)
    return Settings(**base)


def _fake_msg(inp, out):
    return SimpleNamespace(
        usage_metadata={"input_tokens": inp, "output_tokens": out, "total_tokens": inp + out},
        response_metadata={"finish_reason": "stop"},
    )


class _Rec:  # 捕获埋点调用（无 DB）
    def __init__(self): self.usages = []; self.events = []
    def record_usage(self, *a, **k): self.usages.append(k or a)
    def log_event(self, *a, **k): self.events.append(k or a)


def test_get_chat_uses_provider_base_url():
    gw = ModelGateway(_settings())
    chat = gw.get_chat("deepseek")
    assert chat.model_name == "deepseek-chat"
    assert "deepseek.com" in str(chat.openai_api_base)


def test_invoke_failover_to_second_provider(monkeypatch):
    gw = ModelGateway(_settings())

    def fake_get_chat(provider, model=None, **kw):
        def invoke(_messages):
            if provider == "deepseek":
                raise RuntimeError("deepseek down")
            return _fake_msg(100, 20)
        return SimpleNamespace(model_name=model or "m", invoke=invoke)

    monkeypatch.setattr(gw, "get_chat", fake_get_chat)
    rec = _Rec()
    resp = gw.invoke([("user", "hi")], recorder=rec, run_id="r1", agent_type="bidding_agent", node="read")
    assert resp.usage_metadata["input_tokens"] == 100   # 来自回退的 qwen
    assert len(rec.usages) == 1                          # 成功那次记了用量
    assert len(rec.events) >= 1                          # deepseek 失败记了 model.error


def test_telemetry_failure_does_not_failover_or_lose_response(monkeypatch):
    """埋点/DB 写失败绝不能丢已成功的响应、也不能触发（重复计费的）故障转移。"""
    gw = ModelGateway(_settings())
    calls = {"n": 0}

    def fake_get_chat(provider, model=None, **kw):
        def invoke(_messages):
            calls["n"] += 1
            return _fake_msg(50, 10)
        return SimpleNamespace(model_name=model or "m", invoke=invoke)

    monkeypatch.setattr(gw, "get_chat", fake_get_chat)

    class _BoomRec:  # 埋点全炸
        def record_usage(self, *a, **k): raise RuntimeError("db down")
        def log_event(self, *a, **k): raise RuntimeError("db down")

    resp = gw.invoke([("user", "hi")], recorder=_BoomRec(), run_id="r", agent_type="bidding_agent")
    assert resp.usage_metadata["input_tokens"] == 50   # 成功响应照常返回
    assert calls["n"] == 1                              # 只调一次 LLM：埋点炸了没触发转移/重复调用


def test_invoke_all_fail_raises(monkeypatch):
    gw = ModelGateway(_settings())
    monkeypatch.setattr(gw, "get_chat", lambda *a, **k: SimpleNamespace(
        model_name="m", invoke=lambda _m: (_ for _ in ()).throw(RuntimeError("boom"))))
    with pytest.raises(RuntimeError):
        gw.invoke([("user", "x")], recorder=_Rec(), run_id="r2", agent_type="bidding_agent")


def _patch_fake_chat_openai(monkeypatch):
    """monkeypatch agent.models.gateway.ChatOpenAI 为记录 kwargs 的 fake，断言透传最确定。"""
    calls = []

    class _FakeChatOpenAI:
        def __init__(self, **kw):
            calls.append(kw)

    monkeypatch.setattr("agent.models.gateway.ChatOpenAI", _FakeChatOpenAI)
    return calls


def test_get_chat_passes_sampling_params_from_settings(monkeypatch):
    calls = _patch_fake_chat_openai(monkeypatch)
    gw = ModelGateway(_settings(model_temperature=0.3, model_max_tokens=8192, model_top_p=0.9))
    gw.get_chat("deepseek")
    assert calls[-1]["temperature"] == 0.3
    assert calls[-1]["max_tokens"] == 8192
    assert calls[-1]["top_p"] == 0.9


def test_get_chat_omits_sampling_params_when_none(monkeypatch):
    calls = _patch_fake_chat_openai(monkeypatch)
    gw = ModelGateway(_settings())  # 默认全 None
    gw.get_chat("deepseek")
    assert "temperature" not in calls[-1]
    assert "max_tokens" not in calls[-1]
    assert "top_p" not in calls[-1]


def test_get_chat_explicit_kw_overrides_settings(monkeypatch):
    calls = _patch_fake_chat_openai(monkeypatch)
    gw = ModelGateway(_settings(model_temperature=0.3, model_max_tokens=8192, model_top_p=0.9))
    gw.get_chat("deepseek", temperature=0.1, max_tokens=4096, top_p=0.5)
    assert calls[-1]["temperature"] == 0.1   # 三参数对称覆盖
    assert calls[-1]["max_tokens"] == 4096
    assert calls[-1]["top_p"] == 0.5
