from agent.models.gateway import model_override_to_settings
from agent.routes.runs import CreateRunBody


def test_override_maps_and_drops_none():
    out = model_override_to_settings({"provider": "qwen", "model": None, "fallbacks": "glm:glm-4-flash"})
    assert out == {"model_default_provider": "qwen", "model_fallbacks": "glm:glm-4-flash"}
    # model=None 被丢弃，不覆盖


def test_override_none_returns_empty():
    assert model_override_to_settings(None) == {}


def test_create_run_body_parses_model():
    b = CreateRunBody(input={}, thread_id="t1", model={"provider": "deepseek", "model": "deepseek-chat", "fallbacks": ""})
    assert b.model.provider == "deepseek"
    assert b.model.model == "deepseek-chat"
