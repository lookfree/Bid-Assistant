from types import SimpleNamespace

from fastapi.testclient import TestClient

from agent.app import create_app
import agent.routes.models as models_route


def _fake_resp(total_tokens=42):
    return SimpleNamespace(usage_metadata={"total_tokens": total_tokens})


class _FakeChat:
    def __init__(self, resp=None, exc=None):
        self._resp = resp
        self._exc = exc

    async def ainvoke(self, _messages):
        if self._exc:
            raise self._exc
        return self._resp


class _FakeGateway:
    """monkeypatch 目标：按用例定制 get_chat 行为，绕开真实 ChatOpenAI/网络。"""

    def __init__(self, chat=None, raise_err=None):
        self._chat = chat
        self._raise_err = raise_err

    def get_chat(self, provider, model=None, **kw):
        if self._raise_err:
            raise self._raise_err
        return self._chat


def _patch_gateway(monkeypatch, gw):
    monkeypatch.setattr(models_route, "ModelGateway", lambda settings: gw)


def test_models_test_success(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(chat=_FakeChat(resp=_fake_resp(7))))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["tokens"] == 7
    assert body["latency_ms"] >= 0


def test_models_test_missing_api_key(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(raise_err=RuntimeError("缺少 API Key")))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "API Key" in body["error"]


def test_models_test_ainvoke_exception_returns_200(monkeypatch):
    client = TestClient(create_app())
    _patch_gateway(monkeypatch, _FakeGateway(chat=_FakeChat(exc=RuntimeError("model exploded"))))
    res = client.post("/models/test", json={"provider": "deepseek"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "model exploded" in body["error"]


def test_models_test_unknown_provider_400():
    client = TestClient(create_app())
    res = client.post("/models/test", json={"provider": "gpt"})
    assert res.status_code == 400
