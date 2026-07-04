from agent.models.gateway import model_override_to_settings
from agent.routes.runs import CreateRunBody


def test_override_maps_and_drops_none():
    out = model_override_to_settings({"provider": "qwen", "model": None, "fallbacks": "glm:glm-4-flash"})
    assert out == {"model_default_provider": "qwen", "model_fallbacks": "glm:glm-4-flash"}


def test_default_seed_is_noop_empty_fallbacks_inherit_env():
    # Critical: 默认 seed {deepseek, null, ""} 只设 provider，空 fallbacks 继承 env（不清空故障转移链）
    out = model_override_to_settings({"provider": "deepseek", "model": None, "fallbacks": ""})
    assert out == {"model_default_provider": "deepseek"}


def test_unknown_provider_dropped():
    out = model_override_to_settings({"provider": "gpt", "model": "x", "fallbacks": ""})
    assert out == {"model_default_model": "x"}  # provider 未知被丢弃，继承 env provider


def test_override_none_returns_empty():
    assert model_override_to_settings(None) == {}


def test_create_run_body_parses_model():
    b = CreateRunBody(input={}, thread_id="t1", model={"provider": "deepseek", "model": "deepseek-chat", "fallbacks": ""})
    assert b.model.provider == "deepseek"
    assert b.model.model == "deepseek-chat"
