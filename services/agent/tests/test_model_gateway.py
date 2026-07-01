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


def test_invoke_all_fail_raises(monkeypatch):
    gw = ModelGateway(_settings())
    monkeypatch.setattr(gw, "get_chat", lambda *a, **k: SimpleNamespace(
        model_name="m", invoke=lambda _m: (_ for _ in ()).throw(RuntimeError("boom"))))
    with pytest.raises(RuntimeError):
        gw.invoke([("user", "x")], recorder=_Rec(), run_id="r2", agent_type="bidding_agent")
